import test from "node:test";
import assert from "node:assert/strict";
import { ErpError } from "../src/erp/erp.ts";
import { checkCoverage, validatePo, verifyOutcome } from "../src/domain/validator.ts";
import { NODES } from "../src/erp/seed.ts";
import { params, riceErp } from "./helpers.ts";

const base = { sku: "RICE-5KG", node: NODES.main, supplierId: "SUP-AGRO", createdBy: "agent" as const };

test("ERP enforces MOQ, case pack and supplier cap", () => {
  const erp = riceErp();
  assert.throws(() => erp.createPo({ ...base, qty: 50 }), (e) => e instanceof ErpError && e.code === "BELOW_MOQ");
  assert.throws(() => erp.createPo({ ...base, qty: 105 }), (e) => e instanceof ErpError && e.code === "CASE_PACK");
  assert.throws(() => erp.createPo({ ...base, qty: 5010 }), (e) => e instanceof ErpError && e.code === "SUPPLIER_CAPACITY");
});

test("ERP enforces budget and storage and consumes budget on commit", () => {
  const erp = riceErp();
  const before = erp.getBudget("grocery").remainingUsd;
  const po = erp.createPo({ ...base, qty: 200 });
  assert.equal(erp.getBudget("grocery").remainingUsd, before - 800);
  assert.equal(po.status, "open");
  erp.cancelPo(po.id);
  assert.equal(erp.getBudget("grocery").remainingUsd, before, "cancelling releases budget");
});

test("pending POs do not consume budget until approved; approval re-checks budget", () => {
  const erp = riceErp();
  const before = erp.getBudget("grocery").remainingUsd;
  const po = erp.createPo({ ...base, qty: 200, requiresApproval: true });
  assert.equal(po.status, "pending_approval");
  assert.equal(erp.getBudget("grocery").remainingUsd, before);
  const apr = erp.listApprovals()[0];
  const approved = erp.resolveApproval(apr.id, "approved");
  assert.equal(approved.status, "open");
  assert.equal(erp.getBudget("grocery").remainingUsd, before - 800);
  assert.throws(() => erp.resolveApproval(apr.id, "approved"), (e) => e instanceof ErpError && e.code === "BAD_STATE");
});

test("validator accepts a sensible PO and flags excess stock as a warning", () => {
  const erp = riceErp(160);
  const ok = erp.createPo({ ...base, qty: 370 });
  const v = validatePo(erp, ok.id, params);
  assert.equal(v.ok, true);
  const big = erp.createPo({ ...base, qty: 1000 }); // $4000: under the approval limit, but far above target
  const v2 = validatePo(erp, big.id, params);
  assert.equal(v2.ok, true, "excess is a warning, not a violation");
  assert.ok(v2.findings.some((f) => f.code === "EXCESS_STOCK"));
});

test("validator flags an agent PO above the approval limit that was committed without approval", () => {
  const erp = riceErp(160);
  const po = erp.createPo({ ...base, qty: 1500, supplierId: "SUP-AGRO" }); // $6000, bypassing the tool guardrail
  const v = validatePo(erp, po.id, params);
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === "APPROVAL_BYPASSED"));
});

test("verifyOutcome catches a silent partial write", () => {
  const erp = riceErp();
  const trimmed = new (erp.constructor as typeof import("../src/erp/erp.ts").MockErp)(erp.snapshot(), { silentTrimNextCreate: { factor: 0.5 } });
  const po = trimmed.createPo({ ...base, qty: 200 });
  const f = verifyOutcome(po, { sku: "RICE-5KG", node: NODES.main, supplierId: "SUP-AGRO", qty: 200 });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "QTY_MISMATCH");
});

test("checkCoverage reflects supplier-confirmed (not ordered) quantity", () => {
  const erp = riceErp(200);
  const before = checkCoverage(erp, "RICE-5KG", NODES.main, params);
  assert.equal(before.covered, false);
  const po = erp.createPo({ ...base, qty: 600 });
  assert.equal(checkCoverage(erp, "RICE-5KG", NODES.main, params).covered, true);
  erp.setSupplierConfirmation(po.id, 100);
  assert.equal(checkCoverage(erp, "RICE-5KG", NODES.main, params).covered, false);
});
