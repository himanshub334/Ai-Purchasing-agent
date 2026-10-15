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
