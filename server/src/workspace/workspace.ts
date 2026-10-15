import { randomUUID } from "node:crypto";
import { runAgent } from "../agent/runner.ts";
import type { AgentRunResult, Planner } from "../agent/types.ts";
import { MockErp } from "../erp/erp.ts";
import { workspaceState } from "../erp/seed.ts";
import { buildSituation } from "../domain/situation.ts";
import type { PlanParams, Trigger } from "../domain/types.ts";

/**
 * The live application around the agent: a simulated warehouse that evolves day by day, a
 * monitor that notices purchasing problems by itself, and an activity log of everything the
 * agent did. The agent is the same one the scenarios and evals exercise.
 */

export type Provider = "policy" | "anthropic";

export interface Issue {
  key: string;
  type: Trigger["type"];
  trigger: Trigger;
  sku: string;
  node: string;
  reason: string;
  /** days until stock-out (lower = more urgent) */
  urgency: number;
}

export type FeedItem =
  | { seq: number; simDate: string; kind: "world" | "human"; text: string }
  | { seq: number; simDate: string; kind: "agent"; text: string; runId: string; issueType: Issue["type"]; sku: string; node: string; decision: string; status: AgentRunResult["status"]; needsHuman: boolean };

export type WorldEvent =
  | { type: "sales_surge"; sku: string; node: string; multiplier: number }
  | { type: "sales_normal"; sku: string; node: string }
  | { type: "supplier_short"; poId: string; confirmedQty: number }
  | { type: "add_budget"; category: string; amountUsd: number };

export interface PairRow {
  sku: string;
  node: string;
  name: string;
  onHand: number;
  dailyDemand: number;
  demandNote: string;
  incoming: number;
  pendingApprovalQty: number;
  position: number;
  target: number;
  reorderPoint: number;
  daysOfCover: number;
  stockoutDay: number | null;
  health: "healthy" | "needs_order" | "critical" | "excess";
  blockedByEscalation: boolean;
  surge: number;
}

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Workspace {
  erp: MockErp;
  private feed: FeedItem[] = [];
  private runs = new Map<string, AgentRunResult>();
  private seq = 0;
  private handledShortfalls = new Set<string>();
  private multipliers = new Map<string, number>();
  private rng: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private provider: Provider = "policy";
  private autopilotMs = 3000;
  private busy = false;

  constructor(private opts: { params: PlanParams; today: string; seed?: number; plannerFactory: (p: Provider) => Promise<Planner> }) {
    this.erp = new MockErp(workspaceState(opts.today));
    this.rng = mulberry32(opts.seed ?? 42);
    this.log("world", "Workspace started. Stock, demand, open POs and budgets loaded.");
  }

  // ---- control --------------------------------------------------------------------------------

  reset() {
    this.stopAutopilot();
    this.erp = new MockErp(workspaceState(this.opts.today));
    this.rng = mulberry32(this.opts.seed ?? 42);
    this.feed = [];
    this.runs.clear();
    this.handledShortfalls.clear();
    this.multipliers.clear();
    this.seq = 0;
    this.log("world", "Workspace reset to the initial state.");
  }

  get autopilot() {
    return { enabled: Boolean(this.timer), intervalMs: this.autopilotMs, provider: this.provider };
  }

  startAutopilot(intervalMs = 3000, provider: Provider = "policy") {
    this.stopAutopilot();
    this.autopilotMs = Math.max(500, intervalMs);
    this.provider = provider;
    this.timer = setInterval(() => {
      void this.advance(1, provider).catch((e) => this.log("world", `Autopilot tick failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.autopilotMs);
    this.timer.unref();
    this.log("human", `Autopilot on: one simulated day every ${this.autopilotMs / 1000}s, agent monitoring (${provider}).`);
  }

  stopAutopilot() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.log("human", "Autopilot off.");
    }
  }

  // ---- the world --------------------------------------------------------------------------------

  /** Advance N days. After each day the agent scans and handles whatever it finds. */
  async advance(days: number, provider: Provider = this.provider, opts: { scan?: boolean } = {}) {
    if (this.busy) return { skipped: true as const };
    this.busy = true;
    try {
      for (let i = 0; i < days; i++) {
        const mult = this.multipliers;
        const r = this.erp.advanceDay((d) => d.baselineDaily * (mult.get(`${d.sku}@${d.node}`) ?? 1) + (this.rng() * 2 - 1) * d.stdDaily * 0.8);
        for (const rec of r.received) this.log("world", `${rec.poId} arrived: +${rec.qty} ${rec.sku} at ${rec.node}.`, r.date);
        for (const s of r.sales.filter((x) => x.lost > 0)) this.log("world", `Stock-out: lost ${s.lost} units of ${s.sku} at ${s.node}.`, r.date);
        if (opts.scan !== false) await this.scanLocked(provider);
      }
      return { skipped: false as const };
    } finally {
      this.busy = false;
    }
  }

  async scan(provider: Provider = this.provider) {
    if (this.busy) return { skipped: true as const, handled: 0 };
    this.busy = true;
    try {
      return { skipped: false as const, handled: await this.scanLocked(provider) };
    } finally {
      this.busy = false;
    }
  }

  /** Apply a world/human event. When the agent is monitoring (autopilot), it reacts straight away. */
  async applyEventAndReact(e: WorldEvent) {
    this.applyEvent(e);
    if (this.timer) await this.scan(this.provider);
  }

  applyEvent(e: WorldEvent) {
    switch (e.type) {
      case "sales_surge":
        this.erp.getDemand(e.sku, e.node);
        this.multipliers.set(`${e.sku}@${e.node}`, e.multiplier);
        this.log("world", `Sales of ${e.sku} at ${e.node} are now running at ${Math.round(e.multiplier * 100)}% of normal.`);
        break;
      case "sales_normal":
        this.multipliers.delete(`${e.sku}@${e.node}`);
        this.log("world", `Sales of ${e.sku} at ${e.node} are back to normal.`);
        break;
      case "supplier_short": {
        const before = this.erp.getPo(e.poId);
        const po = this.erp.setSupplierConfirmation(e.poId, e.confirmedQty);
        this.log("world", `Supplier ${po.supplierId} can only ship ${po.confirmedQty} of ${before.qty} on ${po.id}.`);
        break;
      }
      case "add_budget": {
        const b = this.erp.addBudget(e.category, e.amountUsd);
        this.log("human", `Buyer released $${e.amountUsd} budget for ${e.category} (now $${b.remainingUsd.toFixed(0)}).`);
        break;
      }
    }
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected") {
    const po = this.erp.resolveApproval(approvalId, decision);
    this.log("human", `Buyer ${decision} ${po.id} (${po.qty} x ${po.sku}).`);
    return po;
  }

  resolveEscalation(id: string) {
    const e = this.erp.resolveEscalation(id);
    this.log("human", `Buyer resolved escalation ${id} for ${e.sku} at ${e.node}; the agent will monitor it again.`);
    return e;
  }

  // ---- monitoring -------------------------------------------------------------------------------

  detectIssues(): Issue[] {
    const params = this.opts.params;
    const issues: Issue[] = [];
    const openEsc = this.erp.listEscalations().filter((e) => e.status === "open");
    for (const { sku, node } of this.erp.listPairs()) {
      if (openEsc.some((e) => e.sku === sku && e.node === node)) continue; // waiting for a human

      const sit = buildSituation(this.erp, sku, node, params);
      const gov = sit.options.find((o) => o.terms.supplierId === sit.primarySupplierId && o.active) ?? sit.options.find((o) => o.active);
      const urgency = gov?.position.stockoutDay ?? 99;

      const short = this.erp.listPos({ sku, node }).find((p) => p.status === "open" && p.confirmedQty < p.qty && !this.handledShortfalls.has(p.id));
      if (short) {
        issues.push({ key: `short:${short.id}`, type: "supplier_shortfall", sku, node, urgency, reason: `${short.id}: supplier confirmed ${short.confirmedQty} of ${short.qty}`, trigger: { type: "supplier_shortfall", poId: short.id, requestedQty: short.qty, confirmedQty: short.confirmedQty } });
        continue;
      }
      // Reorder-point policy: only act once the position has fallen to the reorder point, then order up to target.
      if (!gov || gov.position.netRequirement === 0 || gov.position.inventoryPosition > gov.position.reorderPoint) continue;
      if (sit.demand.sustainedIncrease) {
        issues.push({ key: `demand:${sku}@${node}`, type: "demand_change", sku, node, urgency, reason: `sales at ${Math.round(sit.demand.ratio * 100)}% of baseline; position ${gov.position.inventoryPosition} is at/below the reorder point ${gov.position.reorderPoint}`, trigger: { type: "demand_change", sku, node } });
      } else {
        issues.push({ key: `need:${sku}@${node}`, type: "purchase_needed", sku, node, urgency, reason: `position ${gov.position.inventoryPosition} fell to the reorder point ${gov.position.reorderPoint}; target is ${gov.position.targetPosition}`, trigger: { type: "purchase_needed", sku, node, qty: gov.legalNeedQty, supplierId: gov.terms.supplierId } });
      }
    }
    return issues.sort((a, b) => a.urgency - b.urgency);
  }

  private async scanLocked(provider: Provider): Promise<number> {
    const planner = await this.opts.plannerFactory(provider);
    const attempted = new Set<string>();
    let handled = 0;
    for (let i = 0; i < 20; i++) {
      // Re-detect after every run: earlier actions change budget, storage and positions.
      const issue = this.detectIssues().find((x) => !attempted.has(x.key));
      if (!issue) break;
      attempted.add(issue.key);
      if (issue.trigger.type === "supplier_shortfall") this.handledShortfalls.add(issue.trigger.poId);
      this.log("world", `Monitor: ${issue.type.replace("_", " ")} on ${issue.sku} at ${issue.node} (${issue.reason}). Agent started.`);
      const { result } = await runAgent({ state: this.erp.snapshot(), trigger: issue.trigger, params: this.opts.params, planner, erp: this.erp });
      this.runs.set(result.runId, result);
      if (this.runs.size > 150) this.runs.delete(this.runs.keys().next().value!);
      this.feed.push({ seq: ++this.seq, simDate: this.erp.today(), kind: "agent", text: result.decision.summary, runId: result.runId, issueType: issue.type, sku: issue.sku, node: issue.node, decision: result.decision.action, status: result.status, needsHuman: result.decision.needsHuman });
      this.trimFeed();
      handled++;
    }
    return handled;
  }

  // ---- views ------------------------------------------------------------------------------------

  getRun(id: string) {
    return this.runs.get(id);
  }

  snapshot() {
    const params = this.opts.params;
    const openEsc = this.erp.listEscalations().filter((e) => e.status === "open");
    const rows: PairRow[] = this.erp.listPairs().map(({ sku, node }) => {
      const sit = buildSituation(this.erp, sku, node, params);
      const gov = sit.options.find((o) => o.terms.supplierId === sit.primarySupplierId && o.active) ?? sit.options.find((o) => o.active);
      const pos = gov?.position;
      const minLead = Math.min(...sit.options.filter((o) => o.active).map((o) => o.terms.leadTimeDays));
      const inc = sit.incoming;
      let health: PairRow["health"] = "healthy";
      if (pos && pos.stockoutDay !== null && pos.stockoutDay <= minLead) health = "critical";
      else if (pos && pos.netRequirement > 0 && pos.inventoryPosition <= pos.reorderPoint) health = "needs_order";
      else if (pos && pos.inventoryPosition > pos.targetPosition * params.excessCoverFactor) health = "excess";
      return {
        sku,
        node,
        name: this.erp.getProduct(sku).name,
        onHand: sit.onHand,
        dailyDemand: sit.demand.effectiveDaily,
        demandNote: sit.demand.sustainedIncrease ? "sustained increase" : sit.demand.isolatedSpike ? "one-day spike" : "normal",
        incoming: inc.filter((i) => !i.pendingApproval).reduce((a, i) => a + i.qty, 0),
        pendingApprovalQty: inc.filter((i) => i.pendingApproval).reduce((a, i) => a + i.qty, 0),
        position: pos?.inventoryPosition ?? sit.onHand,
        target: pos?.targetPosition ?? 0,
        reorderPoint: pos?.reorderPoint ?? 0,
        daysOfCover: sit.demand.effectiveDaily > 0 ? Math.round((sit.onHand / sit.demand.effectiveDaily) * 10) / 10 : 999,
        stockoutDay: pos?.stockoutDay ?? null,
        health,
        blockedByEscalation: openEsc.some((e) => e.sku === sku && e.node === node),
        surge: this.multipliers.get(`${sku}@${node}`) ?? 1,
      };
    });
    const st = this.erp.snapshot();
    return {
      simDate: this.erp.today(),
      busy: this.busy,
      autopilot: this.autopilot,
      rows,
      purchaseOrders: st.purchaseOrders.filter((p) => p.status !== "cancelled" && p.status !== "received").sort((a, b) => a.eta.localeCompare(b.eta)),
      approvals: st.approvals.filter((a) => a.status === "pending"),
      escalations: [...st.escalations].reverse().slice(0, 20),
      budgets: st.budgets,
      storage: st.storage.map((s) => ({ ...s, ...this.erp.getStorage(s.node) })),
      feed: this.feed.slice(-120).reverse(),
      products: st.products.map((p) => ({ sku: p.sku, category: p.category })),
      nodes: [...new Set(st.storage.map((s) => s.node))],
    };
  }

  private log(kind: "world" | "human", text: string, simDate?: string) {
    this.feed.push({ seq: ++this.seq, simDate: simDate ?? this.erp.today(), kind, text });
    this.trimFeed();
  }
  private trimFeed() {
    if (this.feed.length > 400) this.feed.splice(0, this.feed.length - 400);
  }
}

export const newWorkspaceId = () => randomUUID();
