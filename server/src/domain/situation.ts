import type { MockErp } from "../erp/erp.ts";
import { assessDemand, computePosition, incomingFromPos, maxLegalQty, legalQty, type DemandAssessment, type Position } from "./replenishment.ts";
import type { NodeId, PlanParams, Sku, SupplierTerms } from "./types.ts";

export interface SupplierOption {
  terms: SupplierTerms;
  supplierName: string;
  reliability: number;
  active: boolean;
  /** qty needed from THIS supplier after MOQ / case pack rounding */
  legalNeedQty: number;
  /** largest qty that fits budget, storage and supplier cap */
  maxFeasibleQty: number;
  bindingConstraints: string[];
  /** day offset at which stock arrives if ordered today */
  arrivalInDays: number;
  /** order placed today would arrive after projected stockout */
  arrivesAfterStockout: boolean;
  cost: number;
  position: Position;
}

export interface Situation {
  sku: Sku;
  node: NodeId;
  today: string;
  onHand: number;
  demand: DemandAssessment;
  incoming: ReturnType<typeof incomingFromPos>;
  budgetRemainingUsd: number;
  storageFreeM3: number;
  unitVolumeM3: number;
  options: SupplierOption[];
  /** supplier we currently buy from (latest PO) or cheapest active */
  primarySupplierId: string;
}

/**
 * One consistent, pure view of "where do we stand" for a SKU at a node. Used by the
 * analysis tool, the policy planner, the validator and the evals so every part of the
 * system agrees on the numbers.
 */
export interface SituationOptions {
  /** suppliers to leave out of the option list */
  exclude?: string[];
  /** per-supplier order-size ceilings learned at runtime (e.g. from ERP rejections) */
  capOverrides?: Record<string, number>;
}

export function buildSituation(erp: MockErp, sku: Sku, node: NodeId, params: PlanParams, opts: SituationOptions = {}): Situation {
  const excludeSupplierIds = opts.exclude ?? [];
  const product = erp.getProduct(sku);
  const inv = erp.getInventory(sku, node);
  const demand = assessDemand(erp.getDemand(sku, node));
  const pos = erp.listPos({ sku, node });
  const incoming = incomingFromPos(pos, erp.today());
  const budget = erp.getBudget(product.category);
  const storage = erp.getStorage(node);
  const std = erp.getDemand(sku, node).stdDaily;

  const options: SupplierOption[] = erp
    .listTerms(sku)
    .filter((t) => !excludeSupplierIds.includes(t.supplierId))
    .map((rawTerms) => {
      const cap = opts.capOverrides?.[rawTerms.supplierId];
      const terms: SupplierTerms =
        cap === undefined ? rawTerms : { ...rawTerms, maxQtyPerOrder: Math.min(rawTerms.maxQtyPerOrder ?? Infinity, cap) };
      const sup = erp.getSupplier(terms.supplierId);
      const position = computePosition({
        onHand: inv.onHand,
        incoming,
        dailyDemand: demand.effectiveDaily,
        stdDaily: std,
        leadTimeDays: terms.leadTimeDays,
        params,
      });
      const limits = { budgetUsd: budget.remainingUsd, freeM3: storage.freeM3, unitVolumeM3: product.unitVolumeM3 };
      const maxLegal = maxLegalQty(terms, limits);
      return {
        terms,
        supplierName: sup.name,
        reliability: sup.reliability,
        active: sup.active,
        legalNeedQty: legalQty(position.netRequirement, terms),
        maxFeasibleQty: maxLegal.qty,
        bindingConstraints: maxLegal.qty < legalQty(position.netRequirement, terms) ? maxLegal.binding : [],
        arrivalInDays: terms.leadTimeDays,
        arrivesAfterStockout: position.stockoutDay !== null && terms.leadTimeDays > position.stockoutDay,
        cost: terms.unitCost,
        position,
      };
    });

  const latest = [...pos].filter((p) => p.status !== "cancelled").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const activeOptions = options.filter((o) => o.active);
  const cheapest = [...activeOptions].sort((a, b) => a.cost - b.cost)[0];
  const primary = latest && options.some((o) => o.terms.supplierId === latest.supplierId && o.active) ? latest.supplierId : (cheapest?.terms.supplierId ?? options[0]?.terms.supplierId ?? "");

  return {
    sku,
    node,
    today: erp.today(),
    onHand: inv.onHand,
    demand,
    incoming,
    budgetRemainingUsd: budget.remainingUsd,
    storageFreeM3: storage.freeM3,
    unitVolumeM3: product.unitVolumeM3,
    options,
    primarySupplierId: primary,
  };
}
