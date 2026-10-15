import type { Decision, DecisionAction } from "../domain/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Planner, RunContext } from "./types.ts";
import type { PurchaseOrder } from "../domain/types.ts";

/**
 * Deterministic planner: investigate -> decide -> act -> verify -> re-plan -> finish.
 *
 * It is a closed loop. After every write it does NOT assume the write did what was intended;
 * it re-reads the world via `analyze_replenishment` (which sees the PO the ERP actually stored)
 * and plans again. That single mechanism recovers from rejected orders, silent partial writes,
 * partially-filled constraints and stale assumptions. The loop ends when the position is
 * covered, nothing feasible is left (escalate), or the step budget is exhausted (escalate).
 */

interface Opt {
  supplierId: string;
  supplierName: string;
  active: boolean;
  reliability: number;
  unitCost: number;
  leadTimeDays: number;
  moq: number;
  netRequirement: number;
  legalNeedQty: number;
  maxFeasibleQty: number;
  bindingConstraints: string[];
  arrivesAfterStockout: boolean;
  stockoutDay: number | null;
  targetPosition: number;
  inventoryPosition: number;
  maxQtyPerOrder: number | null;
}
interface Analysis {
  onHand: number;
  demand: { effectiveDaily: number; planningDaily: number; sustainedIncrease: boolean; isolatedSpike: boolean; forecastStale: boolean; notes: string[]; ratio: number };
  budgetRemainingUsd: number;
  storageFreeM3: number;
  primarySupplierId: string;
  options: Opt[];
}

interface CreatedPo {
  poId: string;
  supplierId: string;
  supplierName: string;
  qty: number;
  status: PurchaseOrder["status"];
  valueUsd: number;
  verified: boolean;
  partialBecause?: string;
}

/** A stock-out is only "urgent" if a new order placed today could not prevent it. */
const unpreventable = (a: Analysis, day: number | null): boolean => {
  if (day === null) return false;
  const leads = a.options.filter((o) => o.active).map((o) => o.leadTimeDays);
  return leads.length === 0 || day <= Math.min(...leads);
};

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export class PolicyPlanner implements Planner {
  readonly name = "policy" as const;

  async run(ctx: RunContext, tools: ToolRegistry): Promise<Decision> {
    const t = ctx.trigger;
    const call = (name: string, input: unknown) => tools.call(ctx, name, input);

    // ---- 1. resolve the subject and gather evidence --------------------------------------
    let sku: string;
    let node: string;
    let preferredSupplier: string | undefined;
    if (t.type === "supplier_shortfall") {
      const r = call("get_purchase_order", { poId: t.poId });
      if (!r.ok) return this.finish(ctx, tools, "escalate", "Could not load the affected purchase order", [`PO ${t.poId} not found`], [], [], true);
      const po = r.data as PurchaseOrder;
      sku = po.sku;
      node = po.node;
      preferredSupplier = po.supplierId;
    } else {
      sku = t.sku;
      node = t.node;
      preferredSupplier = "supplierId" in t ? t.supplierId : undefined;
    }
    call("get_inventory", { sku, node });
    call("get_demand_and_sales", { sku, node });
    call("get_open_purchase_orders", { sku, node });
    call("get_supplier_options", { sku });
    call("get_budget", { sku });
    call("get_storage_capacity", { node, sku });

    // ---- 2. plan / act / verify loop --------------------------------------------------------
    const created: CreatedPo[] = [];
    const rationale: string[] = [];
    const risks: string[] = [];
    const attempted = new Set<string>();
    let escalated: { severity: "low" | "medium" | "high"; summary: string } | undefined;
    let firstAnalysis: Analysis | undefined;
    let lastAnalysis!: Analysis;
    const maxIter = Math.max(2, Math.floor(ctx.params.reviewPeriodDays)); // bounded retries

    for (let iter = 0; iter <= maxIter; iter++) {
      const ar = call("analyze_replenishment", { sku, node });
      lastAnalysis = ar.data as Analysis;
      const a = lastAnalysis;
      firstAnalysis ??= a;
      const gov = a.options.find((o) => o.supplierId === preferredSupplier && o.active) ?? a.options.find((o) => o.supplierId === a.primarySupplierId && o.active) ?? a.options.find((o) => o.active);

      if (iter === 0) {
        this.explainDemand(a, rationale);
        if (a.demand.forecastStale && !a.demand.sustainedIncrease) {
          return this.finishInvestigate(ctx, tools, sku, node, a);
        }
      }
      if (!gov) {
        escalated = { severity: "high", summary: `No active supplier can supply ${sku}.` };
        break;
      }
      if (iter === 0) this.explainPosition(gov, rationale);

      // covered?
      if (gov.netRequirement === 0) {
        if (created.length === 0) return this.finishNoPurchase(ctx, tools, a, gov, rationale);
        break;
      }
      if (iter === 0 && t.type === "demand_change" && !a.demand.sustainedIncrease)
        rationale.push("The demand evidence is not a sustained increase, but there is a replenishment gap anyway, so the normal replenishment rule applies.");

      // choose an option
      const choice = this.choose(a, gov, preferredSupplier);
      if (!choice) {
        escalated = this.noFeasibleOption(a, gov, rationale);
        break;
      }
      const key = `${choice.opt.supplierId}:${choice.qty}`;
      if (attempted.has(key)) {
        escalated = { severity: unpreventable(a, gov.stockoutDay) ? "high" : "medium", summary: "The plan stopped converging (same order proposed twice). Handing over to a buyer." };
        break;
      }
      attempted.add(key);

      if (created.length === 0 || choice.opt.supplierId !== preferredSupplier)
        rationale.push(
          `Chose ${choice.opt.supplierName}: ${choice.full ? "can cover the full requirement" : `can only cover ${choice.qty} of ${choice.opt.legalNeedQty} units`}${choice.opt.arrivesAfterStockout ? ", but arrives after the projected stock-out" : ", arriving before any stock-out"}.`,
        );

      const w = call("create_purchase_order", {
        sku,
        node,
        supplierId: choice.opt.supplierId,
        qty: choice.qty,
        reason: `${t.type}: net requirement ${choice.opt.netRequirement} units (target ${choice.opt.targetPosition}, position ${choice.opt.inventoryPosition})`,
      });

      if (!w.ok) {
        const code = w.error!.code;
        ctx.trace.push({ kind: "recovery", step: ctx.step, text: `create_purchase_order failed (${code}). Re-planning with the new information.` });
        if (code === "SUPPLIER_CAPACITY") {
          rationale.push(`The ERP rejected ${choice.qty} units from ${choice.opt.supplierName}: ${w.error!.message}.`);
          continue; // learnedCaps now applied by analyze_replenishment
        }
        if (code === "DUPLICATE_ORDER" || code === "GUARDRAIL") {
          escalated = { severity: "medium", summary: `A guardrail stopped the order: ${w.error!.message}` };
          break;
        }
        ctx.excludedSuppliers.push(choice.opt.supplierId);
        rationale.push(`Order with ${choice.opt.supplierName} failed (${code}); excluding this supplier.`);
        continue;
      }

      const data = w.data as { po: PurchaseOrder; requiresApproval: boolean; verification: { ok: boolean; findings: Array<{ code: string; severity: string; message: string }> } };
      const partial = choice.qty < choice.opt.legalNeedQty;
      const rec: CreatedPo = {
        poId: data.po.id,
        supplierId: data.po.supplierId,
        supplierName: choice.opt.supplierName,
        qty: data.po.qty,
        status: data.po.status,
        valueUsd: data.po.qty * data.po.unitCost,
        verified: data.verification.ok,
        partialBecause: partial ? choice.opt.bindingConstraints.join("+") || "constraints" : undefined,
      };
      created.push(rec);

      const violations = data.verification.findings.filter((f) => f.severity === "violation");
      if (!data.verification.ok) {
        const onlyQty = violations.every((f) => f.code === "QTY_MISMATCH");
        if (onlyQty) {
          rationale.push(`Verification caught that the ERP stored ${data.po.qty} units instead of the ${choice.qty} requested (${data.po.id}). Re-planning from the stored state to close the gap.`);
        } else {
          const c = call("cancel_purchase_order", { poId: data.po.id, reason: `failed verification: ${violations.map((v) => v.code).join(",")}` });
          rationale.push(`PO ${data.po.id} failed verification (${violations.map((v) => v.code).join(", ")}) and was cancelled${c.ok ? "" : " (cancel failed)"}.`);
          created.pop();
          ctx.excludedSuppliers.push(choice.opt.supplierId);
        }
      }
      // A supplier that could only partly fill us because of its own cap is saturated for this run.
      if (partial && (choice.opt.bindingConstraints.includes("supplier_cap") || ctx.learnedCaps[choice.opt.supplierId] !== undefined)) {
        if (!ctx.excludedSuppliers.includes(choice.opt.supplierId)) ctx.excludedSuppliers.push(choice.opt.supplierId);
      }
      if (data.requiresApproval) rationale.push(`PO value ${money(rec.valueUsd)} exceeds the auto-approve limit of ${money(ctx.params.autoApproveLimitUsd)}: queued for human approval instead of being committed.`);
    }

    // ---- 3. final state ----------------------------------------------------------------------
    const fin = (call("analyze_replenishment", { sku, node }).data ?? lastAnalysis) as Analysis;
    const finGov = fin.options.find((o) => o.supplierId === preferredSupplier && o.active) ?? fin.options.find((o) => o.supplierId === fin.primarySupplierId && o.active) ?? fin.options.find((o) => o.active);
    const stillShort = finGov ? finGov.netRequirement > 0 : true;
    if (stillShort && !escalated) {
      escalated = { severity: finGov && unpreventable(fin, finGov.stockoutDay) ? "high" : "medium", summary: "Could not fully cover the requirement within the step budget." };
    }
    if (escalated) {
      const stockout = finGov?.stockoutDay ?? null;
      const sev = finGov && unpreventable(fin, stockout) ? "high" : escalated.severity === "high" && !finGov ? "high" : "medium";
      const stillNeed = finGov ? finGov.netRequirement : 0;
      call("create_escalation", {
        sku,
        node,
        severity: sev,
        summary: `${escalated.summary} Remaining gap: ${stillNeed} units${stockout !== null ? `; projected stock-out on day ${stockout}` : ""}.`,
        recommendedNextStep: sev === "high" ? "Expedite or source from an off-contract supplier, or arrange inter-node transfer today." : "Release additional budget/storage or approve an alternative supplier, then re-run the agent.",
      });
      escalated = { ...escalated, severity: sev };
    }

    return this.finishWithPurchases(ctx, tools, { created, rationale, risks, escalated, finGov, firstAnalysis: firstAnalysis! });
  }

  // ---- option selection -------------------------------------------------------------------

  private choose(a: Analysis, gov: Opt, preferredId: string | undefined) {
    const need = gov.netRequirement;
    const cands = a.options
      .filter((o) => o.active && o.maxFeasibleQty > 0 && o.netRequirement > 0)
      .map((o) => {
        const qty = o.maxFeasibleQty >= o.legalNeedQty ? o.legalNeedQty : o.maxFeasibleQty;
        return { opt: o, qty, full: o.maxFeasibleQty >= o.legalNeedQty };
      });
    if (!cands.length) return undefined;
    cands.sort((x, y) => {
      if (x.opt.arrivesAfterStockout !== y.opt.arrivesAfterStockout) return x.opt.arrivesAfterStockout ? 1 : -1;
      if (x.full !== y.full) return x.full ? -1 : 1;
      const xp = x.opt.supplierId === (preferredId ?? gov.supplierId);
      const yp = y.opt.supplierId === (preferredId ?? gov.supplierId);
      if (xp !== yp) return xp ? -1 : 1;
      if (!x.full && x.qty !== y.qty) return y.qty - x.qty;
      const xc = x.opt.unitCost / x.opt.reliability;
      const yc = y.opt.unitCost / y.opt.reliability;
      if (xc !== yc) return xc - yc;
      return x.opt.leadTimeDays - y.opt.leadTimeDays;
    });
    void need;
    return cands[0];
  }

  private noFeasibleOption(a: Analysis, gov: Opt, rationale: string[]) {
    for (const o of a.options) {
      if (!o.active) rationale.push(`${o.supplierName} is inactive.`);
      else if (o.maxFeasibleQty === 0)
        rationale.push(`${o.supplierName} cannot be used: ${o.bindingConstraints.length ? o.bindingConstraints.join(" + ") : "constraints"} leave no room for even its minimum order of ${o.moq} units.`);
    }
    return {
      severity: (unpreventable(a, gov.stockoutDay) ? "high" : "medium") as "high" | "medium",
      summary: `Purchase of ${gov.legalNeedQty} units is needed but no supplier option fits the budget ($${a.budgetRemainingUsd.toFixed(0)} left), storage (${a.storageFreeM3} m3 free) and supplier limits.`,
    };
  }

  // ---- explanations -----------------------------------------------------------------------

  private explainDemand(a: Analysis, r: string[]) {
    r.push(`Demand used: ${a.demand.effectiveDaily}/day (forecast ${a.demand.planningDaily}/day).`);
    for (const n of a.demand.notes) r.push(`Demand evidence: ${n}.`);
  }
  private explainPosition(g: Opt, r: string[]) {
    r.push(`Target position ${g.targetPosition} (lead time ${g.leadTimeDays}d + review period, incl. safety stock); current position ${g.inventoryPosition} (stock + inbound POs) => net requirement ${g.netRequirement} units.`);
    if (g.stockoutDay !== null) r.push(`Projected stock-out on day ${g.stockoutDay} without further action.`);
  }

  // ---- finishers --------------------------------------------------------------------------

  private finishNoPurchase(ctx: RunContext, tools: ToolRegistry, a: Analysis, gov: Opt, rationale: string[]): Decision {
    const t = ctx.trigger;
    let action: DecisionAction;
    let summary: string;
    if (t.type === "review_recommendation") {
      action = "reject";
      summary = `Rejected the recommendation to buy ${t.recommendedQty} units: stock plus inbound POs (${gov.inventoryPosition}) already exceed the target (${gov.targetPosition}).`;
      rationale.push(`Buying ${t.recommendedQty} more would take the position to ${gov.inventoryPosition + t.recommendedQty}, about ${(((gov.inventoryPosition + t.recommendedQty) / gov.targetPosition) * 100).toFixed(0)}% of target: excess stock and tied-up cash.`);
    } else if (t.type === "supplier_shortfall") {
      action = "accept";
      summary = `Accepted the supplier's partial fulfilment (${t.confirmedQty} of ${t.requestedQty}): existing stock and inbound quantity still cover the target position, so no replacement order is needed.`;
      rationale.push(`Position with the confirmed quantity is ${gov.inventoryPosition} vs target ${gov.targetPosition}.`);
    } else if (t.type === "demand_change") {
      action = "no_action";
      summary = a.demand.isolatedSpike
        ? "No change to the purchasing plan: the sales increase is a one-day spike, not a trend."
        : "No change to the purchasing plan: current stock and inbound POs already cover the (updated) demand.";
      if (!a.demand.sustainedIncrease) rationale.push("Not extrapolating a single outlier day into a higher plan.");
    } else {
      action = "reject";
      summary = "No purchase is needed: the position already meets the target.";
    }
    return this.finish(ctx, tools, action, summary, rationale, [], [], false);
  }

  private finishInvestigate(ctx: RunContext, tools: ToolRegistry, sku: string, node: string, a: Analysis): Decision {
    tools.call(ctx, "create_escalation", {
      sku,
      node,
      severity: "low",
      summary: `Forecast for ${sku} is stale (see demand evidence) and cannot be trusted to size or reject an order.`,
      recommendedNextStep: "Refresh the forecast, then re-run the review. Interim cover is " + (a.options[0]?.inventoryPosition ?? "n/a") + " units of position.",
    });
    return this.finish(
      ctx,
      tools,
      "investigate",
      "Did not act: the forecast behind this recommendation is stale, so neither accepting, modifying nor rejecting it would be defensible.",
      [...a.demand.notes.map((n) => `Demand evidence: ${n}.`), "Raised a data-quality ticket for a forecast refresh."],
      ["Created escalation ticket (low severity) to refresh the forecast"],
      ["Stock may be insufficient or excessive depending on the true demand"],
      true,
    );
  }

  private finishWithPurchases(
    ctx: RunContext,
    tools: ToolRegistry,
    s: { created: CreatedPo[]; rationale: string[]; risks: string[]; escalated?: { severity: string; summary: string }; finGov?: Opt; firstAnalysis: Analysis },
  ): Decision {
    const t = ctx.trigger;
    const { created, rationale, risks, escalated } = s;
    const total = created.reduce((a, p) => a + p.qty, 0);
    const pending = created.some((p) => p.status === "pending_approval");
    const actions = created.map(
      (p) => `${p.poId}: ${p.qty} units from ${p.supplierName} (${money(p.valueUsd)}) ${p.status === "pending_approval" ? "-> awaiting human approval" : "-> open"}${p.verified ? ", verified" : ", verification flagged"}${p.partialBecause ? ` [partial: ${p.partialBecause}]` : ""}`,
    );
    if (escalated) actions.push(`Escalated to a buyer (${escalated.severity}): ${escalated.summary}`);

    let action: DecisionAction;
    if (escalated?.severity === "high") action = "escalate";
    else if (created.length === 0) action = "escalate";
    else if (t.type === "review_recommendation") {
      const rec = t.recommendedQty;
      const same = created.length === 1 && Math.abs(total - rec) / rec <= 0.1 && !escalated && (!t.supplierId || created[0].supplierId === t.supplierId);
      action = same ? "accept" : "modify";
    } else if (t.type === "purchase_needed") {
      const same = created.length === 1 && Math.abs(total - t.qty) / t.qty <= 0.05 && !escalated;
      action = same ? "accept" : "modify";
    } else {
      action = "modify";
    }

    let summary: string;
    if (created.length === 0) summary = `Could not place an order: ${escalated?.summary ?? "no feasible option"}. Escalated.`;
    else if (t.type === "review_recommendation")
      summary = action === "accept" ? `Accepted the recommendation: ordered ${total} units (recommended ${t.recommendedQty}).` : `Modified the recommendation: ordered ${total} units instead of ${t.recommendedQty}.`;
    else if (t.type === "supplier_shortfall") summary = `Supplier short-shipped (${t.confirmedQty} of ${t.requestedQty}): sourced ${total} replacement units.`;
    else if (t.type === "demand_change") summary = `Demand is running above plan: added ${total} units on top of the existing purchase order(s).`;
    else summary = action === "accept" ? `Executed the required purchase of ${total} units.` : `Purchase adjusted to fit constraints: ordered ${total} units of the ${t.qty} wanted.`;
    if (action === "escalate" && created.length) summary += " A stock-out risk remains and has been escalated.";

    if (escalated) risks.push(escalated.summary);
    if (s.finGov && s.finGov.stockoutDay !== null) risks.push(`Projected stock-out on day ${s.finGov.stockoutDay}.`);
    if (pending) risks.push("PO is not active until a human approves it.");
    const needsHuman = Boolean(escalated) || pending;
    return this.finish(ctx, tools, action, summary, rationale, actions, risks, needsHuman);
  }

  private finish(ctx: RunContext, tools: ToolRegistry, action: DecisionAction, summary: string, rationale: string[], actionsTaken: string[], risks: string[], needsHuman: boolean): Decision {
    const decision: Decision = { action, summary, rationale: rationale.length ? rationale : ["See trace."], actionsTaken, risks, needsHuman };
    tools.call(ctx, "submit_decision", decision);
    return decision;
  }
}
