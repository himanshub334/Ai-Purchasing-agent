import test from "node:test";
import assert from "node:assert/strict";
import { ClaudePlanner } from "../src/agent/claudePlanner.ts";
import { runAgent } from "../src/agent/runner.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { params } from "./helpers.ts";

/** A scripted stand-in for the Anthropic client: lets us test the tool-use loop without network. */
function fakeClient(script: Array<Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>>) {
  let i = 0;
  const seen: any[] = [];
  return {
    seen,
    client: {
      messages: {
        create: async (req: any) => {
          seen.push(req);
          const content = script[Math.min(i++, script.length - 1)];
          return { content, stop_reason: "tool_use" } as any;
        },
      },
    } as any,
  };
}

const s = scenarios.find((x) => x.id === "s1-modify-overbuy")!;

test("claude planner: executes tool calls through the guarded registry and finishes on submit_decision", async () => {
  const { client, seen } = fakeClient([
    [{ type: "text", text: "Let me look at the numbers." }, { type: "tool_use", id: "t1", name: "analyze_replenishment", input: { sku: "RICE-5KG", node: "FC-BLR-01" } }],
    [{ type: "tool_use", id: "t2", name: "create_purchase_order", input: { sku: "RICE-5KG", node: "FC-BLR-01", supplierId: "SUP-AGRO", qty: 170, reason: "net requirement 166 rounded to case pack" } }],
    [{ type: "tool_use", id: "t3", name: "submit_decision", input: { action: "modify", summary: "Reduced from 800 to 170 units.", rationale: ["open PO ignored by recommendation"], actionsTaken: ["created PO"], risks: [], needsHuman: false } }],
  ]);
  const planner = new ClaudePlanner({ apiKey: "test", model: "test-model", maxSteps: 10, client });
  const { result } = await runAgent({ state: s.build(), trigger: s.trigger, params, planner });
  assert.equal(result.decision.action, "modify");
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "anthropic");
  assert.equal(result.endState.purchaseOrders.filter((p) => p.createdBy === "agent").length, 1);
  assert.equal(result.trace.some((e) => e.kind === "thought"), true);
  assert.equal(result.audit.coverage.covered, true);
  // the second request must carry the first tool result back to the model
  assert.equal(seen[1].messages.at(-1).content[0].type, "tool_result");
  assert.ok(seen[0].tools.length >= 10);
});

test("claude planner: a model that never submits a decision ends as a failed run needing a human, not a silent success", async () => {
  const { client } = fakeClient([[{ type: "tool_use", id: "t1", name: "get_inventory", input: { sku: "RICE-5KG", node: "FC-BLR-01" } }]]);
  const planner = new ClaudePlanner({ apiKey: "test", model: "test-model", maxSteps: 3, client });
  const { result } = await runAgent({ state: s.build(), trigger: s.trigger, params, planner });
  assert.equal(result.status, "failed");
  assert.equal(result.decision.action, "escalate");
  assert.equal(result.decision.needsHuman, true);
});

test("claude planner: the LLM cannot bypass the approval limit even if it tries", async () => {
  const big = scenarios.find((x) => x.id === "s4-approval-required")!;
  const { client } = fakeClient([
    [{ type: "tool_use", id: "t1", name: "create_purchase_order", input: { sku: "WATER-6PK", node: "FC-BLR-01", supplierId: "SUP-FRESH", qty: 2232, reason: "just buy it all right now" } }],
    [{ type: "tool_use", id: "t2", name: "submit_decision", input: { action: "accept", summary: "Bought everything.", rationale: ["needed"], actionsTaken: [], risks: [], needsHuman: false } }],
  ]);
  const planner = new ClaudePlanner({ apiKey: "test", model: "test-model", maxSteps: 5, client });
  const { result } = await runAgent({ state: big.build(), trigger: big.trigger, params, planner });
  const po = result.endState.purchaseOrders.find((p) => p.createdBy === "agent")!;
  assert.equal(po.status, "pending_approval");
  assert.equal(result.endState.approvals.length, 1);
});
