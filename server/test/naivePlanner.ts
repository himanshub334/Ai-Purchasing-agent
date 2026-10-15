import type { Planner, RunContext } from "../src/agent/types.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import type { Decision, PurchaseOrder } from "../src/domain/types.ts";

/**
 * A deliberately bad "buyer bot": it never investigates and blindly executes whatever it is
 * told. It exists to prove the evaluation can tell a good agent from a bad one.
 */
export class NaivePlanner implements Planner {
  readonly name = "policy" as const;
  async run(ctx: RunContext, tools: ToolRegistry): Promise<Decision> {
    const t = ctx.trigger;
    let actions: string[] = [];
    if (t.type === "review_recommendation" || t.type === "purchase_needed") {
      const qty = t.type === "review_recommendation" ? t.recommendedQty : t.qty;
      const sup = t.supplierId ?? "SUP-AGRO";
      const r = tools.call(ctx, "create_purchase_order", { sku: t.sku, node: t.node, supplierId: sup, qty, reason: "execute as instructed" });
      actions = [r.ok ? "created PO" : `failed: ${r.error?.code}`];
    } else if (t.type === "supplier_shortfall") {
      const po = tools.call(ctx, "get_purchase_order", { poId: t.poId }).data as PurchaseOrder;
      const r = tools.call(ctx, "create_purchase_order", { sku: po.sku, node: po.node, supplierId: po.supplierId, qty: t.requestedQty - t.confirmedQty, reason: "replace shortfall" });
      actions = [r.ok ? "created PO" : `failed: ${r.error?.code}`];
    }
    const d: Decision = { action: "accept", summary: "Executed as requested.", rationale: ["followed the instruction"], actionsTaken: actions, risks: [], needsHuman: false };
    tools.call(ctx, "submit_decision", d);
    return d;
  }
}
