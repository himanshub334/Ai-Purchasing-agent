import test from "node:test";
import assert from "node:assert/strict";
import { PolicyPlanner } from "../src/agent/policyPlanner.ts";
import { runEvals } from "../src/eval/runner.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { NaivePlanner } from "./naivePlanner.ts";
import { params } from "./helpers.ts";

test("the policy agent passes every scenario on every dimension", async () => {
  const reports = await runEvals({ planner: new PolicyPlanner(), params });
  assert.equal(reports.length, scenarios.length);
  const failures = reports.filter((r) => !r.pass).map((r) => `${r.id}: ${Object.entries(r.dimensions).filter(([, d]) => !d.pass).map(([k, d]) => `${k} (${d.detail})`).join("; ")}`);
  assert.deepEqual(failures, []);
});

test("the evals can fail: a naive agent that blindly executes is caught", async () => {
  const reports = await runEvals({ planner: new NaivePlanner(), params });
  const failed = new Map(reports.filter((r) => !r.pass).map((r) => [r.id, r]));
  // Over-buying, buying when nothing is needed and acting on a stale forecast must all be caught.
  for (const id of ["s1-modify-overbuy", "s1-reject-no-need", "s1-investigate-stale-forecast"]) assert.ok(failed.has(id), `${id} should fail for the naive agent`);
  // Constraint-blind buying hits the ERP's hard limits and must not be scored as success.
  assert.ok(failed.has("s4-budget-constraint"));
  assert.ok(failed.has("s4-storage-constraint"));
  // The naive agent never recovers from a rejected / trimmed write.
  assert.ok(failed.has("s4-fault-supplier-rejects-order"));
  assert.ok(failed.has("s4-fault-silent-partial-write"));
  assert.ok(failed.size >= 8, `expected the naive agent to fail most scenarios, failed only ${failed.size}`);
});

test("the policy agent is deterministic", async () => {
  const strip = (rs: Awaited<ReturnType<typeof runEvals>>) => rs.map((r) => [r.id, r.decision, r.result.endState.purchaseOrders.map((p) => [p.supplierId, p.qty, p.status])]);
  const a = await runEvals({ planner: new PolicyPlanner(), params });
  const b = await runEvals({ planner: new PolicyPlanner(), params });
  assert.deepEqual(strip(a), strip(b));
});

test("approval flow: a queued PO becomes real only after a human approves it", async () => {
  const { runAgent } = await import("../src/agent/runner.ts");
  const s = scenarios.find((x) => x.id === "s4-approval-required")!;
  const { result, erp } = await runAgent({ state: s.build(), trigger: s.trigger, params, planner: new PolicyPlanner() });
  const po = result.endState.purchaseOrders.find((p) => p.createdBy === "agent")!;
  assert.equal(po.status, "pending_approval");
  const before = erp.getBudget("beverages").remainingUsd;
  erp.resolveApproval(result.endState.approvals[0].id, "approved");
  assert.equal(erp.getPo(po.id).status, "open");
  assert.ok(erp.getBudget("beverages").remainingUsd < before);
});
