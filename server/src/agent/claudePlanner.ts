import Anthropic from "@anthropic-ai/sdk";
import type { Decision, Trigger } from "../domain/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Planner, RunContext } from "./types.ts";

/**
 * LLM planner. Claude investigates and decides through the SAME tool layer the deterministic
 * planner uses, so guardrails (approval limit, duplicate-order block, run value cap), read-back
 * verification and the final independent audit apply identically. The model is never given a
 * way to write to the ERP except through those tools.
 */

export const SYSTEM_PROMPT = `You are an AI purchasing agent for a quick-commerce retailer. You help a buyer by investigating a purchasing situation, deciding what to do, taking action in the purchasing system, and validating the result.

Principles
- A recommendation or a trigger is NOT necessarily correct. Verify it against inventory, demand evidence, open purchase orders (use the supplier-confirmed quantity, not the ordered quantity), supplier terms, budget and storage before acting.
- Do not do arithmetic yourself: call analyze_replenishment. It gives the target position, net requirement, stock-out day, and for each supplier the legal order quantity (MOQ, case pack) and the maximum quantity that fits budget, storage and the supplier's own cap.
- Decide among: accept (execute as proposed), modify (act, but differently), reject (no purchase needed), investigate (inputs are untrustworthy, do not act, raise a ticket), escalate (cannot be resolved alone), no_action (plan needs no change).
- Sales evidence: a sustained increase over most of the last 7 days is a trend; one outlier day is not. A stale forecast (older than 14 days) cannot be used to approve or reject an order: investigate.
- Prefer the supplier the recommendation names; use another supplier only when it cannot cover the need, cannot arrive in time, or is inactive.
- Never exceed budget or storage. If constraints allow only part of the requirement, order what fits and escalate the remainder with create_escalation. If a stock-out cannot be prevented by any order, escalate with severity high.
- Orders above the auto-approve limit are queued for human approval by the system. That is expected, not an error. Say so in your decision (needsHuman = true).
- After every create_purchase_order, read the verification block in the result. If the stored quantity differs from what you asked for, or any violation is reported, correct it (call analyze_replenishment again and close the remaining gap, or cancel the faulty PO). If a call fails, read the error, adapt and try again.
- Do not create duplicate orders. Re-run analyze_replenishment after writes to confirm the position is covered.
- Finish by calling submit_decision exactly once with an honest rationale: the important factors, what you did, and residual risks.`;

function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case "review_recommendation":
      return `The purchasing system recommends buying ${t.recommendedQty} units of ${t.sku} at node ${t.node}${t.supplierId ? ` from ${t.supplierId}` : ""}. Review this recommendation and act.`;
    case "supplier_shortfall":
      return `Purchase order ${t.poId} was created for ${t.requestedQty} units, but the supplier says it can currently supply only ${t.confirmedQty} units. Decide what should happen next.`;
    case "demand_change":
      return `Actual sales of ${t.sku} at node ${t.node} look much higher than expected. Investigate whether the purchasing plan needs to change.`;
    case "purchase_needed":
      return `Additional inventory of about ${t.qty} units of ${t.sku} at node ${t.node} should be purchased${t.supplierId ? ` (usual supplier ${t.supplierId})` : ""}. One or more constraints may prevent executing this as recommended: find an appropriate course of action.`;
  }
}

export interface ClaudePlannerOptions {
  apiKey: string;
  model: string;
  maxSteps: number;
  /** injectable for tests */
  client?: Pick<Anthropic, "messages">;
}

export class ClaudePlanner implements Planner {
  readonly name = "anthropic" as const;
  private client: Pick<Anthropic, "messages">;

  constructor(private opts: ClaudePlannerOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  async run(ctx: RunContext, tools: ToolRegistry): Promise<Decision> {
    const toolDefs = tools.list().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: describeTrigger(ctx.trigger) }];

    for (let turn = 0; turn < this.opts.maxSteps; turn++) {
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: toolDefs,
        messages,
      });
      messages.push({ role: "assistant", content: res.content });

      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) ctx.trace.push({ kind: "thought", step: ctx.step, text: block.text.trim() });
      }
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        // The model stopped talking without finishing: nudge it once per turn until the step budget ends.
        if (ctx.decision) return ctx.decision;
        messages.push({ role: "user", content: "You have not called submit_decision yet. Finish the task by calling it." });
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = uses.map((u) => {
        const r = tools.call(ctx, u.name, u.input);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r), is_error: !r.ok };
      });
      messages.push({ role: "user", content: results });
      if (ctx.decision) return ctx.decision;
    }
    throw new Error(`agent exceeded ${this.opts.maxSteps} turns without submitting a decision`);
  }
}
