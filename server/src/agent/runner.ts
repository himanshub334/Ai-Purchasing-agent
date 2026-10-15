import { randomUUID } from "node:crypto";
import { MockErp } from "../erp/erp.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { checkCoverage, validatePo } from "../domain/validator.ts";
import type { Decision, ErpState, FaultPlan, PlanParams, Trigger } from "../domain/types.ts";
import type { AgentRunResult, FinalAudit, Planner, RunContext, RunStatus } from "./types.ts";

export interface RunInput {
  state: ErpState;
  faults?: FaultPlan;
  trigger: Trigger;
  params: PlanParams;
  planner: Planner;
  /** a pre-built ERP lets the API keep state between runs and approvals */
  erp?: MockErp;
}

/**
 * Runs one agent episode and then performs an *independent* final audit that does not depend on
 * what the agent says it did: every agent-created PO is re-validated and coverage is recomputed.
 */
export async function runAgent(input: RunInput): Promise<{ result: AgentRunResult; erp: MockErp }> {
  const erp = input.erp ?? new MockErp(input.state, input.faults);
  const tools = new ToolRegistry();
  const ctx: RunContext = {
    erp,
    params: input.params,
    trigger: input.trigger,
    trace: [],
    writes: [],
    learnedCaps: {},
    excludedSuppliers: [],
    step: 0,
    writeErrors: [],
  };

  const started = performance.now();
  let decision: Decision;
  let failed = false;
  try {
    decision = await input.planner.run(ctx, tools);
    if (!ctx.decision) {
      // the planner returned without submitting: never leave a run without a recorded decision
      failed = true;
      decision = { action: "escalate", summary: "Agent ended without submitting a decision.", rationale: ["No submit_decision call was recorded."], actionsTaken: [], risks: [], needsHuman: true };
    }
  } catch (e) {
    failed = true;
    decision = {
      action: "escalate",
      summary: `Agent failed: ${e instanceof Error ? e.message : String(e)}`,
      rationale: ["Unhandled error in the agent loop; no further actions were taken."],
      actionsTaken: [],
      risks: ["State may be partially updated; review purchase orders created in this run."],
      needsHuman: true,
    };
  }
  decision = ctx.decision ?? decision;

  const subject = subjectOf(erp, input.trigger);
  const agentPos = erp.listPos().filter((p) => p.createdBy === "agent" && p.status !== "cancelled");
  const audit: FinalAudit = {
    coverage: checkCoverage(erp, subject.sku, subject.node, input.params),
    poValidations: agentPos.map((p) => validatePo(erp, p.id, input.params)),
    unverifiedWrites: ctx.writes.filter((w) => w.tool === "create_purchase_order" && !w.verified).length,
  };

  const hasViolation = audit.poValidations.some((v) => !v.ok);
  const status: RunStatus = failed ? "failed" : decision.needsHuman || hasViolation ? "needs_human" : "completed";

  const result: AgentRunResult = {
    runId: randomUUID(),
    provider: input.planner.name,
    trigger: input.trigger,
    status,
    decision,
    trace: ctx.trace,
    audit,
    writeErrors: ctx.writeErrors,
    endState: { purchaseOrders: erp.listPos({ sku: subject.sku, node: subject.node }), approvals: erp.listApprovals(), escalations: erp.listEscalations() },
    durationMs: Math.round(performance.now() - started),
  };
  return { result, erp };
}

export function subjectOf(erp: MockErp, t: Trigger): { sku: string; node: string } {
  if (t.type === "supplier_shortfall") {
    const po = erp.getPo(t.poId);
    return { sku: po.sku, node: po.node };
  }
  return { sku: t.sku, node: t.node };
}
