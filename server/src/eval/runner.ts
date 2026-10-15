import { runAgent } from "../agent/runner.ts";
import type { AgentRunResult, Planner } from "../agent/types.ts";
import type { PlanParams } from "../domain/types.ts";
import { scenarios as allScenarios, type Scenario } from "../scenarios/index.ts";

/**
 * Evaluation = the six questions from the brief, each scored independently per scenario.
 * Expectations are written by hand per scenario (not derived from the agent's own maths), and
 * the constraint / validation checks read the *final ERP state*, not the agent's claims.
 */

export const DIMENSIONS = ["decision", "information", "constraints", "action", "validation", "recovery"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionResult {
  pass: boolean;
  detail: string;
}

export interface ScenarioReport {
  id: string;
  group: string;
  title: string;
  pass: boolean;
  dimensions: Record<Dimension, DimensionResult>;
  decision: string;
  summary: string;
  durationMs: number;
  result: AgentRunResult;
}

export function scoreScenario(s: Scenario, r: AgentRunResult): Omit<ScenarioReport, "durationMs" | "result" | "pass"> & { dims: Record<Dimension, DimensionResult> } {
  const e = s.expect;
  const toolsUsed = new Set(r.trace.filter((t) => t.kind === "tool").map((t) => (t as { tool: string }).tool));
  const agentPos = r.endState.purchaseOrders.filter((p) => p.createdBy === "agent" && p.status !== "cancelled");

  // 1. Was the decision correct?
  const decision: DimensionResult = e.decision.includes(r.decision.action)
    ? { pass: true, detail: `decision "${r.decision.action}"` }
    : { pass: false, detail: `expected ${e.decision.join("|")}, got "${r.decision.action}"` };

  // 2. Did it obtain the necessary information?
  const missing = e.mustRead.filter((t) => !toolsUsed.has(t));
  const information: DimensionResult = missing.length ? { pass: false, detail: `never called: ${missing.join(", ")}` } : { pass: true, detail: `called all ${e.mustRead.length} required read tools` };

  // 3. Did it respect the constraints? (independent audit of the final state)
  const violations = r.audit.poValidations.flatMap((v) => v.findings.filter((f) => f.severity === "violation").map((f) => `${v.poId}:${f.code}`));
  const constraints: DimensionResult = violations.length ? { pass: false, detail: `violations: ${violations.join(", ")}` } : { pass: true, detail: `${r.audit.poValidations.length} agent PO(s) pass budget/storage/MOQ/case-pack/approval checks` };

  // 4. Did it take the appropriate action?
  const problems: string[] = [];
  if (agentPos.length < e.poCount.min || agentPos.length > e.poCount.max) problems.push(`created ${agentPos.length} PO(s), expected ${e.poCount.min}-${e.poCount.max}`);
  const handedToHuman = r.decision.needsHuman && (r.endState.escalations.length > 0 || r.endState.approvals.length > 0);
  if (e.needsHuman && !handedToHuman) problems.push("expected hand-off to a human (escalation/approval) but none recorded");
  if (!e.needsHuman && r.decision.needsHuman) problems.push("escalated although the agent should have been able to act alone");
  problems.push(...(e.check?.(r) ?? []));
  const action: DimensionResult = problems.length ? { pass: false, detail: problems.join("; ") } : { pass: true, detail: `${agentPos.length} PO(s), human hand-off ${handedToHuman ? "yes" : "no"}` };

  // 5. Did it validate the result?
  const createEvents = r.trace.filter((t) => t.kind === "tool" && (t as { tool: string }).tool === "create_purchase_order" && (t as { ok: boolean }).ok).length;
  const verifyEvents = r.trace.filter((t) => t.kind === "verification").length;
  const finalAnalysis = r.trace.filter((t) => t.kind === "tool" && (t as { tool: string }).tool === "analyze_replenishment").length;
  const vProblems: string[] = [];
  if (verifyEvents < createEvents) vProblems.push(`${createEvents} PO write(s) but only ${verifyEvents} verification(s)`);
  if (createEvents > 0 && finalAnalysis < 2) vProblems.push("did not re-analyse the state after writing");
  if (e.decision.every((d) => d !== "escalate" && d !== "investigate") && !e.needsHuman && !r.audit.coverage.covered) vProblems.push(`end state not covered (shortfall ${r.audit.coverage.shortfall}, stock-out day ${r.audit.coverage.stockoutDay})`);
  const validation: DimensionResult = vProblems.length ? { pass: false, detail: vProblems.join("; ") } : { pass: true, detail: createEvents ? `${verifyEvents} read-back verification(s); final position ${r.audit.coverage.position}/${r.audit.coverage.target}` : "no writes; final state audited" };

  // 6. What happens when the initial action does not work?
  let recovery: DimensionResult;
  if (e.recovery) {
    const sawProblem = r.writeErrors.length > 0 || r.trace.some((t) => t.kind === "verification" && !t.ok);
    const recovered = r.audit.coverage.covered && r.status !== "failed";
    recovery = sawProblem && recovered ? { pass: true, detail: `fault observed (${r.writeErrors.map((w) => w.code).join(",") || "verification mismatch"}) and recovered: coverage restored` } : { pass: false, detail: `fault observed: ${sawProblem}; recovered: ${recovered}` };
  } else {
    recovery = r.writeErrors.length === 0 && r.status !== "failed" ? { pass: true, detail: "no faults; no failed writes" } : { pass: false, detail: `unexpected write errors: ${r.writeErrors.map((w) => w.code).join(",")}` };
  }

  return { id: s.id, group: s.group, title: s.title, decision: r.decision.action, summary: r.decision.summary, dims: { decision, information, constraints, action, validation, recovery } } as never;
}

export async function runEvals(opts: { planner: Planner; params: PlanParams; only?: string[]; scenarios?: Scenario[] }): Promise<ScenarioReport[]> {
  const list = (opts.scenarios ?? allScenarios).filter((s) => !opts.only?.length || opts.only.includes(s.id));
  const out: ScenarioReport[] = [];
  for (const s of list) {
    const t0 = performance.now();
    const { result } = await runAgent({ state: s.build(), faults: s.faults, trigger: s.trigger, params: opts.params, planner: opts.planner });
    const scored = scoreScenario(s, result) as unknown as { dims: Record<Dimension, DimensionResult> };
    out.push({
      id: s.id,
      group: s.group,
      title: s.title,
      pass: DIMENSIONS.every((d) => scored.dims[d].pass),
      dimensions: scored.dims,
      decision: result.decision.action,
      summary: result.decision.summary,
      durationMs: Math.round(performance.now() - t0),
      result,
    });
  }
  return out;
}
