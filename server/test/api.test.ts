import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { PolicyPlanner } from "../src/agent/policyPlanner.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const app = createApp({ plannerFactory: async () => new PolicyPlanner() });
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("api: health, scenario list, run, validation errors", async () => {
  await withServer(async (base) => {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
    const list = await (await fetch(`${base}/api/scenarios`)).json();
    assert.ok(list.length >= 10);
    const run = await (await post(`${base}/api/runs`, { scenarioId: "s1-modify-overbuy" })).json();
    assert.equal(run.decision.action, "modify");
    assert.equal(run.status, "completed");
    assert.equal((await post(`${base}/api/runs`, { scenarioId: "nope" })).status, 404);
    assert.equal((await post(`${base}/api/runs`, {})).status, 400);
  });
});

test("api: human approval completes the PO and cannot be applied twice", async () => {
  await withServer(async (base) => {
    const run = await (await post(`${base}/api/runs`, { scenarioId: "s4-approval-required" })).json();
    assert.equal(run.status, "needs_human");
    const apr = run.endState.approvals[0];
    const ok = await post(`${base}/api/runs/${run.runId}/approvals/${apr.id}`, { decision: "approved" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).po.status, "open");
    assert.equal((await post(`${base}/api/runs/${run.runId}/approvals/${apr.id}`, { decision: "approved" })).status, 409);
  });
});

test("api: evals endpoint reports pass counts", async () => {
  await withServer(async (base) => {
    const r = await (await post(`${base}/api/evals`, {})).json();
    assert.equal(r.passed, r.total);
    assert.ok(r.reports[0].dimensions.decision);
  });
});

test("api: asking for the LLM provider without a key is a clean 400, not a crash", async () => {
  const app = createApp(); // real factory
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const prev = process.env.ANTHROPIC_API_KEY;
    const r = await post(`${base}/api/runs`, { scenarioId: "s1-modify-overbuy", provider: "anthropic" });
    assert.equal(r.status, 400);
    process.env.ANTHROPIC_API_KEY = prev;
  } finally {
    server.close();
  }
});
