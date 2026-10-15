import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../config.ts";
import { runAgent } from "../agent/runner.ts";
import { createPlanner } from "../agent/factory.ts";
import { runEvals } from "../eval/runner.ts";
import { MockErp, ErpError } from "../erp/erp.ts";
import { scenarios, getScenario } from "../scenarios/index.ts";
import type { AgentRunResult, Planner } from "../agent/types.ts";
import { Workspace } from "../workspace/workspace.ts";

/**
 * HTTP API for the UI. Each scenario run gets its own isolated MockErp "sandbox" that is kept in
 * memory so that, after a run, a human can approve/reject queued POs and the audit can be re-run.
 */

interface Session {
  erp: MockErp;
  scenarioId: string;
  result: AgentRunResult;
}

export function createApp(opts: { plannerFactory?: (p: "policy" | "anthropic") => Promise<Planner> } = {}) {
  const app = express();
  const sessions = new Map<string, Session>();
  const MAX_SESSIONS = 100;
  const makePlanner = opts.plannerFactory ?? createPlanner;

  app.use(cors());
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: config.provider, anthropicConfigured: Boolean(config.anthropicApiKey), simDate: config.simDate });
  });

  app.get("/api/scenarios", (_req, res) => {
    res.json(scenarios.map((s) => ({ id: s.id, group: s.group, title: s.title, description: s.description, trigger: s.trigger, faults: s.faults ?? null, expectedDecision: s.expect.decision })));
  });

  const runBody = z.object({ scenarioId: z.string(), provider: z.enum(["policy", "anthropic"]).optional() });
  app.post("/api/runs", async (req, res, next) => {
    try {
      const body = runBody.parse(req.body);
      const scenario = getScenario(body.scenarioId);
      if (!scenario) return res.status(404).json({ error: `unknown scenario ${body.scenarioId}` });
      const planner = await makePlanner(body.provider ?? config.provider);
      const { result, erp } = await runAgent({ state: scenario.build(), faults: scenario.faults, trigger: scenario.trigger, params: config.params, planner });
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      sessions.set(result.runId, { erp, scenarioId: scenario.id, result });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/runs/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "run not found" });
    res.json({ ...s.result, endState: { ...s.result.endState, approvals: s.erp.listApprovals(), purchaseOrders: s.erp.listPos(), escalations: s.erp.listEscalations() } });
  });

  // Human approval queue: this is the only way a pending PO becomes a real one.
  const approvalBody = z.object({ decision: z.enum(["approved", "rejected"]) });
  app.post("/api/runs/:id/approvals/:approvalId", (req, res, next) => {
    try {
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: "run not found" });
      const { decision } = approvalBody.parse(req.body);
      const po = s.erp.resolveApproval(req.params.approvalId, decision);
      res.json({ po, approvals: s.erp.listApprovals() });
    } catch (e) {
      next(e);
    }
  });

  const evalBody = z.object({ provider: z.enum(["policy", "anthropic"]).optional(), only: z.array(z.string()).optional() });
  app.post("/api/evals", async (req, res, next) => {
    try {
      const body = evalBody.parse(req.body ?? {});
      const planner = await makePlanner(body.provider ?? config.provider);
      const reports = await runEvals({ planner, params: config.params, only: body.only });
      res.json({
        planner: planner.name,
        passed: reports.filter((r) => r.pass).length,
        total: reports.length,
        reports: reports.map((r) => ({ id: r.id, group: r.group, title: r.title, pass: r.pass, decision: r.decision, summary: r.summary, dimensions: r.dimensions, durationMs: r.durationMs })),
      });
    } catch (e) {
      next(e);
    }
  });

  // ---- live workspace: simulated warehouse + monitoring agent ----------------------------------
  const ws = new Workspace({ params: config.params, today: config.simDate, plannerFactory: makePlanner });
  const provider = z.enum(["policy", "anthropic"]).optional();

  // The agent works in the background: by the time anyone opens the app it has already
  // reviewed the day-one position. Requests wait for that first pass to finish.
  const ready = ws.scan(config.provider).catch((e) => console.error("[workspace] initial scan failed:", e instanceof Error ? e.message : e));
  app.use("/api/workspace", async (_req, _res, next) => {
    await ready;
    next();
  });

  app.get("/api/workspace", (_req, res) => res.json(ws.snapshot()));

  app.post("/api/workspace/advance", async (req, res, next) => {
    try {
      const b = z.object({ days: z.number().int().min(1).max(30).default(1), provider }).parse(req.body ?? {});
      const r = await ws.advance(b.days, b.provider ?? config.provider);
      res.json({ ...r, workspace: ws.snapshot() });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/scan", async (req, res, next) => {
    try {
      const b = z.object({ provider }).parse(req.body ?? {});
      const r = await ws.scan(b.provider ?? config.provider);
      res.json({ ...r, workspace: ws.snapshot() });
    } catch (e) {
      next(e);
    }
  });

  const eventBody = z.discriminatedUnion("type", [
    z.object({ type: z.literal("sales_surge"), sku: z.string(), node: z.string(), multiplier: z.number().min(0.2).max(5) }),
    z.object({ type: z.literal("sales_normal"), sku: z.string(), node: z.string() }),
    z.object({ type: z.literal("supplier_short"), poId: z.string(), confirmedQty: z.number().int().min(0) }),
    z.object({ type: z.literal("add_budget"), category: z.string(), amountUsd: z.number().positive().max(1_000_000) }),
  ]);
  app.post("/api/workspace/events", async (req, res, next) => {
    try {
      await ws.applyEventAndReact(eventBody.parse(req.body));
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/autopilot", (req, res, next) => {
    try {
      const b = z.object({ enabled: z.boolean(), intervalMs: z.number().int().min(500).max(60_000).optional(), provider }).parse(req.body);
      if (b.enabled) ws.startAutopilot(b.intervalMs ?? 3000, b.provider ?? config.provider);
      else ws.stopAutopilot();
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/reset", async (_req, res, next) => {
    try {
      ws.reset();
      await ws.scan(config.provider);
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/approvals/:id", (req, res, next) => {
    try {
      const { decision } = approvalBody.parse(req.body);
      ws.resolveApproval(req.params.id, decision);
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/escalations/:id/resolve", (req, res, next) => {
    try {
      ws.resolveEscalation(req.params.id);
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/workspace/items/:sku/:node", (req, res, next) => {
    try {
      res.json(ws.itemDetail(req.params.sku, req.params.node));
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/workspace/suppliers", (_req, res) => res.json(ws.suppliersView()));

  const settingsBody = z.object({ mode: z.enum(["autonomous", "approve_all", "paused"]).optional(), autoApproveLimitUsd: z.number().min(0).max(1_000_000).optional() });
  app.post("/api/workspace/settings", async (req, res, next) => {
    try {
      const wasPaused = ws.getSettings().mode === "paused";
      ws.setSettings(settingsBody.parse(req.body));
      // resuming: the agent immediately catches up on whatever happened while it was paused
      if (wasPaused && ws.getSettings().mode !== "paused") await ws.scan(config.provider);
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  const orderBody = z.object({ sku: z.string(), node: z.string(), supplierId: z.string(), qty: z.number().int().positive().max(1_000_000) });
  app.post("/api/workspace/orders", (req, res, next) => {
    try {
      const r = ws.createManualOrder(orderBody.parse(req.body));
      res.status(201).json({ ...r, workspace: ws.snapshot() });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workspace/orders/:id/cancel", (req, res, next) => {
    try {
      ws.cancelOrder(req.params.id);
      res.json(ws.snapshot());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/workspace/runs/:id", (req, res) => {
    const r = ws.getRun(req.params.id);
    if (!r) return res.status(404).json({ error: "run not found" });
    res.json(r);
  });

  // Serve the built UI in production (single container).
  // Works from source (server/src/api) and from the esbuild bundle (server/dist).
  const webDist = ["../../../web/dist", "../../web/dist"].map((p) => fileURLToPath(new URL(p, import.meta.url))).find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(`${webDist}/index.html`));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "invalid request", issues: err.issues });
    if (err instanceof ErpError) return res.status(err.code === "NOT_FOUND" ? 404 : 409).json({ error: err.message, code: err.code, details: err.details });
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api] unhandled error:", message);
    const clientError = /requires ANTHROPIC_API_KEY/.test(message);
    res.status(clientError ? 400 : 500).json({ error: message });
  });

  return app;
}
