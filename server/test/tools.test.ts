import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.ts";
import { NODES } from "../src/erp/seed.ts";
import { ctxFor, riceErp } from "./helpers.ts";

const tools = new ToolRegistry();
const order = { sku: "RICE-5KG", node: NODES.main, supplierId: "SUP-AGRO", qty: 200, reason: "unit test order" };

test("tools never throw: bad input and unknown tools return structured errors", () => {
  const ctx = ctxFor(riceErp());
  assert.equal(tools.call(ctx, "nope", {}).error?.code, "UNKNOWN_TOOL");
  assert.equal(tools.call(ctx, "create_purchase_order", { sku: "RICE-5KG" }).error?.code, "INVALID_INPUT");
  assert.equal(tools.call(ctx, "get_inventory", { sku: "NOPE", node: NODES.main }).error?.code, "NOT_FOUND");
});

test("create_purchase_order verifies by reading back and records a verification event", () => {
  const ctx = ctxFor(riceErp());
  const r = tools.call(ctx, "create_purchase_order", order);
  assert.equal(r.ok, true);
  assert.equal((r.data as any).verification.ok, true);
  assert.equal(ctx.trace.filter((e) => e.kind === "verification").length, 1);
  // tool event precedes its verification event
  assert.equal(ctx.trace[0].kind, "tool");
  assert.equal(ctx.trace[1].kind, "verification");
});

test("guardrail: orders above the auto-approve limit are queued, never committed", () => {
  const ctx = ctxFor(riceErp());
  const r = tools.call(ctx, "create_purchase_order", { ...order, qty: 1500 }); // $6000
  assert.equal((r.data as any).status, "pending_approval");
  assert.equal(ctx.erp.listApprovals().length, 1);
});

test("guardrail: identical duplicate order in a run is refused", () => {
  const ctx = ctxFor(riceErp());
  assert.equal(tools.call(ctx, "create_purchase_order", order).ok, true);
  assert.equal(tools.call(ctx, "create_purchase_order", order).error?.code, "DUPLICATE_ORDER");
});

test("guardrail: run value cap stops runaway ordering", () => {
  const ctx = ctxFor(riceErp());
  // each order is ~$6000 and is queued for approval (no budget used); cap is 10x limit = $50,000
  let blocked = false;
  for (let i = 0; i < 12 && !blocked; i++) {
    const r = tools.call(ctx, "create_purchase_order", { ...order, qty: 1500 + i * 10 });
    blocked = r.error?.code === "GUARDRAIL";
  }
  assert.equal(blocked, true);
});

test("guardrail: the agent can only cancel POs it created", () => {
  const ctx = ctxFor(riceErp());
  ctx.erp.createPo({ sku: "RICE-5KG", node: NODES.main, supplierId: "SUP-AGRO", qty: 100, createdBy: "buyer" });
  const buyerPo = ctx.erp.listPos()[0];
  assert.equal(tools.call(ctx, "cancel_purchase_order", { poId: buyerPo.id, reason: "agent trying to cancel" }).error?.code, "GUARDRAIL");
});

test("ERP capacity rejection is returned as an error and the cap is learned", () => {
  const erp = riceErp();
  const faulty = new (erp.constructor as any)(erp.snapshot(), { rejectNextCreate: { maxQty: 150 } });
  const ctx = ctxFor(faulty);
  const r = tools.call(ctx, "create_purchase_order", order);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "SUPPLIER_CAPACITY");
  assert.equal(ctx.learnedCaps["SUP-AGRO"], 150);
  assert.equal(ctx.writeErrors.length, 1);
});

test("tool schemas are valid JSON schema objects for the LLM", () => {
  for (const t of tools.list()) {
    assert.equal((t.input_schema as any).type, "object", t.name);
    assert.ok(t.description.length > 20, t.name);
  }
});
