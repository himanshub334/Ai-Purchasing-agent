import { daysBetween } from "./dates.ts";
import type { DemandInfo, PlanParams, PurchaseOrder, SupplierTerms } from "./types.ts";

/**
 * Pure replenishment maths. No I/O. Everything the agent (and the evals) reason about
 * numerically lives here so it is unit-testable and explainable.
 */

export interface DemandAssessment {
  /** units/day the plan should use */
  effectiveDaily: number;
  planningDaily: number;
  recentMeanDaily: number;
  recentMedianDaily: number;
  /** recent median / baseline */
  ratio: number;
  /** sustained, broad-based increase (not a one-day spike) */
  sustainedIncrease: boolean;
  /** a single day explains most of the excess: likely one-off, do not extrapolate */
  isolatedSpike: boolean;
  forecastStale: boolean;
  notes: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const STALE_FORECAST_DAYS = 14;

export function assessDemand(d: DemandInfo): DemandAssessment {
  const last7 = d.dailySales.slice(-7);
  const recentMean = mean(last7);
  const recentMedian = median(last7);
  const ratio = d.baselineDaily > 0 ? recentMedian / d.baselineDaily : 1;
  const daysAbove = last7.filter((x) => x >= d.baselineDaily * 1.2).length;
  const sustainedIncrease = last7.length >= 5 && ratio >= 1.3 && daysAbove >= 5;

  const excess = last7.map((x) => Math.max(0, x - d.baselineDaily));
  const totalExcess = excess.reduce((a, b) => a + b, 0);
  const isolatedSpike = totalExcess > 0 && Math.max(...excess) / totalExcess > 0.6 && !sustainedIncrease;

  const notes: string[] = [];
  const forecastStale = d.forecastAgeDays > STALE_FORECAST_DAYS;
  if (forecastStale) notes.push(`forecast is ${d.forecastAgeDays} days old (stale)`);
  if (sustainedIncrease)
    notes.push(`sales ran at ${(ratio * 100).toFixed(0)}% of baseline on ${daysAbove}/7 days: sustained increase`);
  if (isolatedSpike) notes.push("one day explains most of the recent excess: treated as a one-off spike");
  if (d.promoActive) notes.push("a promotion is active: uplift may be temporary");

  const effectiveDaily = sustainedIncrease ? Math.max(recentMean, d.forecastDaily) : d.forecastDaily;
  return {
    effectiveDaily: round2(effectiveDaily),
    planningDaily: d.forecastDaily,
    recentMeanDaily: round2(recentMean),
    recentMedianDaily: round2(recentMedian),
    ratio: round2(ratio),
    sustainedIncrease,
    isolatedSpike,
    forecastStale,
    notes,
  };
}

export interface IncomingPo {
  poId: string;
  qty: number;
  etaOffsetDays: number;
  pendingApproval: boolean;
}

/** Quantity that will actually arrive. Supplier confirmation beats the original order qty. */
export function incomingFromPos(pos: PurchaseOrder[], today: string): IncomingPo[] {
  return pos
    .filter((p) => p.status === "open" || p.status === "pending_approval")
    .map((p) => ({
      poId: p.id,
      qty: p.status === "open" ? p.confirmedQty : p.qty,
      etaOffsetDays: Math.max(0, daysBetween(today, p.eta)),
      pendingApproval: p.status === "pending_approval",
    }));
}

export interface PositionInput {
  onHand: number;
  incoming: IncomingPo[];
  dailyDemand: number;
  stdDaily: number;
  leadTimeDays: number;
  params: PlanParams;
}

export interface Position {
  horizonDays: number;
  safetyStock: number;
  targetPosition: number;
  incomingQty: number;
  inventoryPosition: number;
  netRequirement: number;
  daysOfCoverNow: number;
  /** first day (1-based) stock hits zero if nothing else arrives, or null within horizon */
  stockoutDay: number | null;
  targetCoverDays: number;
}

export function computePosition(i: PositionInput): Position {
  const horizon = i.leadTimeDays + i.params.reviewPeriodDays;
  const safety = Math.ceil(i.params.serviceLevelZ * i.stdDaily * Math.sqrt(horizon));
  const target = Math.ceil(i.dailyDemand * horizon) + safety;
  const incomingQty = i.incoming.reduce((a, p) => a + p.qty, 0);
  const position = i.onHand + incomingQty;

  let stock = i.onHand;
  let stockoutDay: number | null = null;
  for (let day = 1; day <= horizon; day++) {
    stock += i.incoming.filter((p) => p.etaOffsetDays === day).reduce((a, p) => a + p.qty, 0);
    stock -= i.dailyDemand;
    if (stock < 0) {
      stockoutDay = day;
      break;
    }
  }
  return {
    horizonDays: horizon,
    safetyStock: safety,
    targetPosition: target,
    incomingQty,
    inventoryPosition: position,
    netRequirement: Math.max(0, target - position),
    daysOfCoverNow: i.dailyDemand > 0 ? round2(i.onHand / i.dailyDemand) : Infinity,
    stockoutDay,
    targetCoverDays: i.dailyDemand > 0 ? round2(target / i.dailyDemand) : 0,
  };
}

/** Round a needed quantity up to a legal order quantity (case pack, MOQ). */
export function legalQty(need: number, t: SupplierTerms): number {
  if (need <= 0) return 0;
  const cases = Math.ceil(need / t.casePack);
  const moqCases = Math.ceil(t.moq / t.casePack);
  return Math.max(cases, moqCases) * t.casePack;
}

/** Largest legal qty that fits all ceilings (budget, storage, supplier cap). 0 if none fits MOQ. */
export function maxLegalQty(
  t: SupplierTerms,
  limits: { budgetUsd: number; freeM3: number; unitVolumeM3: number },
): { qty: number; binding: Array<"budget" | "storage" | "supplier_cap"> } {
  const byBudget = Math.floor(limits.budgetUsd / t.unitCost);
  const byStorage = Math.floor(limits.freeM3 / limits.unitVolumeM3);
  const byCap = t.maxQtyPerOrder ?? Infinity;
  const raw = Math.min(byBudget, byStorage, byCap);
  const qty = Math.floor(raw / t.casePack) * t.casePack;
  const binding: Array<"budget" | "storage" | "supplier_cap"> = [];
  if (raw === byBudget) binding.push("budget");
  if (raw === byStorage) binding.push("storage");
  if (raw === byCap) binding.push("supplier_cap");
  return { qty: qty >= t.moq ? qty : 0, binding };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
