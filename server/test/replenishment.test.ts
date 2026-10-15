import test from "node:test";
import assert from "node:assert/strict";
import { assessDemand, computePosition, legalQty, maxLegalQty } from "../src/domain/replenishment.ts";
import { params } from "./helpers.ts";

const terms = { supplierId: "S", sku: "X", unitCost: 4, leadTimeDays: 5, moq: 100, casePack: 10, maxQtyPerOrder: 5000 };

test("legalQty rounds up to case pack and enforces MOQ", () => {
  assert.equal(legalQty(0, terms), 0);
  assert.equal(legalQty(1, terms), 100);
  assert.equal(legalQty(166, terms), 170);
  assert.equal(legalQty(170, terms), 170);
});

test("maxLegalQty is limited by the tightest constraint and returns 0 below MOQ", () => {
  const roomy = maxLegalQty(terms, { budgetUsd: 1_000_000, freeM3: 1000, unitVolumeM3: 0.01 });
  assert.equal(roomy.qty, 5000);
  const byBudget = maxLegalQty(terms, { budgetUsd: 900, freeM3: 1000, unitVolumeM3: 0.01 });
  assert.equal(byBudget.qty, 220);
  assert.deepEqual(byBudget.binding, ["budget"]);
  const tooTight = maxLegalQty(terms, { budgetUsd: 300, freeM3: 1000, unitVolumeM3: 0.01 });
  assert.equal(tooTight.qty, 0, "75 units fits the budget but is below the MOQ of 100");
});

test("computePosition: target = demand x (lead + review) + safety stock", () => {
  const p = computePosition({ onHand: 160, incoming: [{ poId: "a", qty: 200, etaOffsetDays: 3, pendingApproval: false }], dailyDemand: 40, stdDaily: 8, leadTimeDays: 5, params });
  assert.equal(p.horizonDays, 12);
  assert.equal(p.safetyStock, 46);
  assert.equal(p.targetPosition, 526);
  assert.equal(p.inventoryPosition, 360);
  assert.equal(p.netRequirement, 166);
  assert.equal(p.stockoutDay, 10, "position 360 < 12-day demand 480, so stock runs out on day 10 without another order");
});

test("computePosition finds the stock-out day and counts arrivals before demand that day", () => {
  const p = computePosition({ onHand: 100, incoming: [{ poId: "a", qty: 500, etaOffsetDays: 4, pendingApproval: false }], dailyDemand: 40, stdDaily: 0, leadTimeDays: 3, params });
  assert.equal(p.stockoutDay, 3); // 100-40-40-40 < 0 on day 3, before the PO lands on day 4
});

test("assessDemand: sustained increase vs one-day spike vs stale forecast", () => {
  const base = { sku: "X", node: "N", baselineDaily: 60, forecastDaily: 60, stdDaily: 10, forecastAgeDays: 1, promoActive: false };
  const sustained = assessDemand({ ...base, dailySales: [58, 61, 60, 59, 62, 60, 61, 82, 85, 90, 88, 95, 92, 97] });
  assert.equal(sustained.sustainedIncrease, true);
  assert.ok(sustained.effectiveDaily > 85);
  const spike = assessDemand({ ...base, dailySales: [59, 61, 60, 58, 62, 60, 61, 60, 62, 59, 210, 61, 60, 58] });
  assert.equal(spike.sustainedIncrease, false);
  assert.equal(spike.isolatedSpike, true);
  assert.equal(spike.effectiveDaily, 60, "a spike must not raise planning demand");
  const stale = assessDemand({ ...base, dailySales: Array(14).fill(60), forecastAgeDays: 30 });
  assert.equal(stale.forecastStale, true);
});
