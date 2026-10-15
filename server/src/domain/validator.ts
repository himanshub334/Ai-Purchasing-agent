import type { MockErp } from "../erp/erp.ts";
import { buildSituation } from "./situation.ts";
import { computePosition } from "./replenishment.ts";
import { addDays } from "./dates.ts";
import type { PlanParams, PurchaseOrder } from "./types.ts";

export type Severity = "violation" | "warning";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
}

export interface PoValidation {
  poId: string;
  ok: boolean; // no violations
  findings: Finding[];
}

/**
 * Independent acceptance check for a purchase order. It re-reads the PO and the surrounding
 * state from the ERP (it does not trust the agent's or the ERP write-call's return value) and
 * checks it against supplier terms, budget, storage and coverage. This is the "is the resulting
 * purchase order actually acceptable?" half of the feedback loop.
 */
export function validatePo(erp: MockErp, poId: string, params: PlanParams): PoValidation {
  const po = erp.getPo(poId);
  const findings: Finding[] = [];
  const add = (code: string, severity: Severity, message: string) => findings.push({ code, severity, message });

  if (po.status === "cancelled") {
    add("PO_CANCELLED", "violation", "PO is cancelled");
    return { poId, ok: false, findings };
  }

  const product = erp.getProduct(po.sku);
  const terms = erp.getTerms(po.sku, po.supplierId);
  const supplier = erp.getSupplier(po.supplierId);
  const effQty = po.status === "open" ? po.confirmedQty : po.qty;

  if (!supplier.active) add("SUPPLIER_INACTIVE", "violation", `supplier ${supplier.name} is inactive`);
  if (po.qty < terms.moq) add("BELOW_MOQ", "violation", `qty ${po.qty} < MOQ ${terms.moq}`);
  if (po.qty % terms.casePack !== 0) add("CASE_PACK", "violation", `qty ${po.qty} not a multiple of case pack ${terms.casePack}`);
  if (terms.maxQtyPerOrder !== undefined && po.qty > terms.maxQtyPerOrder)
    add("SUPPLIER_CAP", "violation", `qty ${po.qty} > supplier max ${terms.maxQtyPerOrder}`);
  if (Math.abs(po.unitCost - terms.unitCost) > 1e-9) add("PRICE_MISMATCH", "warning", `PO price ${po.unitCost} differs from contract ${terms.unitCost}`);
  if (po.eta !== addDays(po.createdAt, terms.leadTimeDays)) add("ETA_MISMATCH", "warning", `ETA ${po.eta} does not match lead time ${terms.leadTimeDays}d`);

  // Budget & storage: open POs have already consumed them, so the ledger must not be overdrawn.
  // Pending POs have not, so the value must fit what is left.
  const budget = erp.getBudget(product.category);
  const storage = erp.getStorage(po.node);
  const value = effQty * po.unitCost;
  const vol = effQty * product.unitVolumeM3;
  if (po.status === "open") {
    if (budget.remainingUsd < 0) add("OVER_BUDGET", "violation", `budget overdrawn: $${budget.remainingUsd.toFixed(2)}`);
    if (storage.freeM3 < 0) add("OVER_STORAGE", "violation", `storage overbooked by ${(-storage.freeM3).toFixed(1)} m3`);
  } else {
    if (value > budget.remainingUsd) add("OVER_BUDGET", "violation", `PO $${value.toFixed(0)} > remaining budget $${budget.remainingUsd.toFixed(0)}`);
    if (vol > storage.freeM3) add("OVER_STORAGE", "violation", `PO ${vol.toFixed(1)} m3 > free ${storage.freeM3} m3`);
  }
  if (po.status === "pending_approval" && value <= params.autoApproveLimitUsd)
    add("UNNEEDED_APPROVAL", "warning", "PO is below the auto-approve limit but waits for approval");
  if (po.status === "open" && po.createdBy === "agent" && value > params.autoApproveLimitUsd)
    add("APPROVAL_BYPASSED", "violation", `agent-created PO of $${value.toFixed(0)} exceeds auto-approve limit $${params.autoApproveLimitUsd} without approval`);

  // Coverage: is the order sensible given demand?
  const sit = buildSituation(erp, po.sku, po.node, params);
  const t = sit.options.find((o) => o.terms.supplierId === po.supplierId);
  if (t) {
    const pos = t.position;
    if (pos.inventoryPosition > pos.targetPosition * params.excessCoverFactor)
      add("EXCESS_STOCK", "warning", `position ${pos.inventoryPosition} is >${params.excessCoverFactor}x target ${pos.targetPosition}`);
    if (pos.stockoutDay !== null) add("STOCKOUT_RISK", "warning", `projected stock-out on day ${pos.stockoutDay} even with this PO`);
  }
  return { poId, ok: !findings.some((f) => f.severity === "violation"), findings };
}

export interface ExpectedPo {
  sku: string;
  node: string;
  supplierId: string;
  qty: number;
}

/** Did the ERP end up with what the agent intended? Catches silent partial writes. */
export function verifyOutcome(po: PurchaseOrder, expected: ExpectedPo): Finding[] {
  const out: Finding[] = [];
  if (po.sku !== expected.sku || po.node !== expected.node) out.push({ code: "TARGET_MISMATCH", severity: "violation", message: "PO targets a different sku/node" });
  if (po.supplierId !== expected.supplierId) out.push({ code: "SUPPLIER_MISMATCH", severity: "violation", message: `PO supplier ${po.supplierId} != intended ${expected.supplierId}` });
  if (po.qty !== expected.qty) out.push({ code: "QTY_MISMATCH", severity: "violation", message: `ERP stored qty ${po.qty}, intended ${expected.qty}` });
  return out;
}

export interface CoverageCheck {
  covered: boolean;
  stockoutDay: number | null;
  position: number;
  target: number;
  shortfall: number;
}

/** Final audit: is the SKU adequately covered under the effective demand? */
export function checkCoverage(erp: MockErp, sku: string, node: string, params: PlanParams): CoverageCheck {
  const sit = buildSituation(erp, sku, node, params);
  const o = sit.options.find((x) => x.terms.supplierId === sit.primarySupplierId) ?? sit.options[0];
  const pos = o
    ? o.position
    : computePosition({ onHand: sit.onHand, incoming: sit.incoming, dailyDemand: sit.demand.effectiveDaily, stdDaily: 0, leadTimeDays: 0, params });
  return {
    covered: pos.netRequirement === 0 && pos.stockoutDay === null,
    stockoutDay: pos.stockoutDay,
    position: pos.inventoryPosition,
    target: pos.targetPosition,
    shortfall: pos.netRequirement,
  };
}
