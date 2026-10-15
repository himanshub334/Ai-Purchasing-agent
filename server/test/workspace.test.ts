import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { PolicyPlanner } from "../src/agent/policyPlanner.ts";
import { createApp } from "../src/api/app.ts";
import { Workspace } from "../src/workspace/workspace.ts";
import { params } from "./helpers.ts";

const make = (p = params) => new Workspace({ params: p, today: "2026-10-14", plannerFactory: async () => new PolicyPlanner() });
const agentRuns = (ws: Workspace) => ws.snapshot().feed.filter((f) => f.kind === "agent");

test("day one: the monitor finds exactly the SKUs at their reorder point, not healthy or excess ones", () => {
  const ws = make();
  const found = ws.detectIssues().map((i) => `${i.sku}@${i.node}`).sort();
  assert.deepEqual(found, ["MILK-1L@FC-BLR-01", "WATER-6PK@DS-BLR-07"]);
  const health = Object.fromEntries(ws.snapshot().rows.map((r) => [`${r.sku}@${r.node}`, r.health]));
  assert.equal(health["NOODLE-4PK@FC-BLR-01"], "excess");
  assert.equal(health["RICE-5KG@FC-BLR-01"], "healthy");
});

test("scan: the agent resolves the issues, its POs pass the audit, and a second scan does nothing", async () => {
  const ws = make();
  const r = await ws.scan();
  assert.equal(r.skipped, false);
  assert.equal((r as { handled: number }).handled, 2);
  assert.equal(ws.detectIssues().length, 0);
  for (const f of agentRuns(ws)) {
    const run = ws.getRun((f as { runId: string }).runId)!;
    assert.equal(run.audit.poValidations.every((v) => v.ok), true);
    assert.equal(run.audit.coverage.covered, true);
  }
  assert.equal(((await ws.scan()) as { handled: number }).handled, 0, "idempotent: no duplicate orders");
});

test("advance: POs arrive on their ETA and stock is consumed by sales", async () => {
  const ws = make();
  const before = ws.snapshot().rows.find((r) => r.sku === "RICE-5KG")!.onHand;
  await ws.advance(2, "policy", { scan: false });
  const feed = ws.snapshot().feed.map((f) => f.text).join("\n");
  assert.match(feed, /PO-0001 arrived: \+200 RICE-5KG/);
  const after = ws.snapshot().rows.find((r) => r.sku === "RICE-5KG")!.onHand;
  assert.ok(after > before + 100, "200 units arrived, ~80 sold");
  assert.equal(ws.snapshot().simDate, "2026-10-16");
});

test("event: a supplier short-ship is detected and handled exactly once", async () => {
  const ws = make();
  ws.applyEvent({ type: "supplier_short", poId: "PO-0002", confirmedQty: 100 }); // WATER main, 400 ordered
  const r1 = await ws.scan();
  assert.ok((r1 as { handled: number }).handled >= 1);
  const run = agentRuns(ws).find((f) => (f as { issueType: string }).issueType === "supplier_shortfall");
  assert.ok(run, "a supplier_shortfall run happened");
  const full = ws.getRun((run as { runId: string }).runId)!;
  assert.equal(full.trigger.type, "supplier_shortfall");
  const before = agentRuns(ws).length;
  await ws.scan();
  assert.equal(agentRuns(ws).filter((f) => (f as { issueType: string }).issueType === "supplier_shortfall").length, 1);
  assert.ok(agentRuns(ws).length >= before);
});

test("event: a sustained sales surge is recognised as a demand change within two weeks", async () => {
  const ws = make();
  await ws.scan();
  ws.applyEvent({ type: "sales_surge", sku: "RICE-5KG", node: "FC-BLR-01", multiplier: 2 });
  await ws.advance(14);
  const dc = agentRuns(ws).filter((f) => (f as { issueType: string }).issueType === "demand_change" && (f as { sku: string }).sku === "RICE-5KG");
  assert.ok(dc.length >= 1, "agent reacted with a demand_change run");
  assert.ok(dc.every((f) => (f as { decision: string }).decision === "modify"));
});

test("constraint: an escalation parks the SKU until a human resolves it, then the agent resumes", async () => {
  const ws = make();
  (ws.erp as unknown as { deductBudget(c: string, n: number): void }).deductBudget("dairy", 7_950); // $50 left
  await ws.scan();
  const esc = ws.snapshot().escalations.find((e) => e.sku === "MILK-1L" && e.status === "open");
  assert.ok(esc, "budget shortage escalated");
  assert.equal(ws.snapshot().rows.find((r) => r.sku === "MILK-1L")!.blockedByEscalation, true);
  assert.equal(((await ws.scan()) as { handled: number }).handled, 0, "no repeat while waiting for the human");

  ws.resolveEscalation(esc!.id);
  ws.applyEvent({ type: "add_budget", category: "dairy", amountUsd: 5_000 });
  const r = (await ws.scan()) as { handled: number };
  assert.ok(r.handled >= 1);
  assert.equal(ws.snapshot().rows.find((x) => x.sku === "MILK-1L")!.health, "healthy");
});

test("approval: large POs wait for a human; the position counts them so the agent does not order twice", async () => {
  const ws = make({ ...params, autoApproveLimitUsd: 500 });
  await ws.scan();
  const snap = ws.snapshot();
  assert.ok(snap.approvals.length >= 1);
  const budgetBefore = snap.budgets.find((b) => b.category === "dairy")!.remainingUsd;
  assert.equal(((await ws.scan()) as { handled: number }).handled, 0);
  const apr = snap.approvals[0];
  ws.resolveApproval(apr.id, "approved");
  assert.ok(ws.snapshot().approvals.length < snap.approvals.length);
  const cat = ws.snapshot().products.find((p) => p.sku === ws.snapshot().purchaseOrders.find((o) => o.id === apr.poId)!.sku)!.category;
  assert.ok(ws.snapshot().budgets.find((b) => b.category === cat)!.remainingUsd < (cat === "dairy" ? budgetBefore : Infinity) + 1);
});

test("simulation is deterministic for a given seed, and reset restores the initial state", async () => {
  const a = make();
  const b = make();
  await a.advance(10);
  await b.advance(10);
  assert.deepEqual(a.snapshot().rows, b.snapshot().rows);
  a.reset();
  assert.equal(a.snapshot().simDate, "2026-10-14");
  assert.deepEqual(a.snapshot().rows, make().snapshot().rows);
});

test("busy lock: overlapping advance calls are skipped instead of corrupting state", async () => {
  const ws = make();
  const [x, y] = await Promise.all([ws.advance(3), ws.advance(3)]);
  assert.equal([x, y].filter((r) => r.skipped).length, 1);
  assert.equal(ws.snapshot().simDate, "2026-10-17");
});

test("api: workspace endpoints drive the live app", async () => {
  const app = createApp({ plannerFactory: async () => new PolicyPlanner() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (u: string, b: unknown = {}) => fetch(base + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const snap0 = await (await fetch(`${base}/api/workspace`)).json();
    assert.equal(snap0.rows.length, 5);
    const adv = await (await post("/api/workspace/advance", { days: 3 })).json();
    assert.equal(adv.workspace.simDate, "2026-10-17");
    assert.ok(adv.workspace.feed.some((f: any) => f.kind === "agent"));
    const runId = adv.workspace.feed.find((f: any) => f.kind === "agent").runId;
    const run = await (await fetch(`${base}/api/workspace/runs/${runId}`)).json();
    assert.ok(run.trace.length > 5);
    assert.equal((await post("/api/workspace/events", { type: "sales_surge", sku: "RICE-5KG", node: "FC-BLR-01", multiplier: 99 })).status, 400);
    assert.equal((await post("/api/workspace/events", { type: "sales_surge", sku: "NOPE", node: "FC-BLR-01", multiplier: 2 })).status, 404);
    assert.equal((await post("/api/workspace/advance", { days: 0 })).status, 400);
    const on = await (await post("/api/workspace/autopilot", { enabled: true, intervalMs: 500 })).json();
    assert.equal(on.autopilot.enabled, true);
    const off = await (await post("/api/workspace/autopilot", { enabled: false })).json();
    assert.equal(off.autopilot.enabled, false);
    const reset = await (await post("/api/workspace/reset")).json();
    assert.equal(reset.simDate, "2026-10-14");
  } finally {
    server.close();
  }
});
