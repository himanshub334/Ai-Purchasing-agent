import { MockErp } from "../src/erp/erp.ts";
import { baseState, demand, inv, NODES } from "../src/erp/seed.ts";
import type { PlanParams, Trigger } from "../src/domain/types.ts";
import type { RunContext } from "../src/agent/types.ts";

export const TODAY = "2026-10-14";
export const params: PlanParams = { reviewPeriodDays: 7, serviceLevelZ: 1.65, excessCoverFactor: 1.5, autoApproveLimitUsd: 5000 };

export function riceErp(onHand = 160) {
  const s = baseState(TODAY);
  s.inventory.push(inv("RICE-5KG", NODES.main, onHand, TODAY));
  s.demand.push(demand({ sku: "RICE-5KG", node: NODES.main, baselineDaily: 40 }));
  return new MockErp(s);
}

export function ctxFor(erp: MockErp, trigger?: Trigger): RunContext {
  return {
    erp,
    params,
    trigger: trigger ?? { type: "purchase_needed", sku: "RICE-5KG", node: NODES.main, qty: 100 },
    trace: [],
    writes: [],
    learnedCaps: {},
    excludedSuppliers: [],
    step: 0,
    writeErrors: [],
  };
}
