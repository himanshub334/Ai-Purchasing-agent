import type { MockErp } from "../erp/erp.ts";
import type { Decision, PlanParams, Trigger } from "../domain/types.ts";
import type { CoverageCheck, Finding, PoValidation } from "../domain/validator.ts";

export type TraceEvent =
  | { kind: "tool"; step: number; tool: string; write: boolean; input: unknown; ok: boolean; output: unknown; ms: number }
  | { kind: "verification"; step: number; poId: string; expected?: unknown; ok: boolean; findings: Finding[] }
  | { kind: "thought"; step: number; text: string }
  | { kind: "recovery"; step: number; text: string };

export interface WriteRecord {
  tool: string;
  poId?: string;
  intended?: { sku: string; node: string; supplierId: string; qty: number };
  verified: boolean;
  findings: Finding[];
}

export interface RunContext {
  erp: MockErp;
  params: PlanParams;
  trigger: Trigger;
  trace: TraceEvent[];
  writes: WriteRecord[];
  /** supplier caps learned from ERP rejections during this run */
  learnedCaps: Record<string, number>;
  /** suppliers that must not be used again in this run */
  excludedSuppliers: string[];
  step: number;
  /** errors returned by write tools (used by the evals to prove recovery) */
  writeErrors: Array<{ tool: string; code: string; message: string }>;
  decision?: Decision;
}

export interface FinalAudit {
  coverage: CoverageCheck;
  poValidations: PoValidation[];
  unverifiedWrites: number;
}

export type RunStatus = "completed" | "needs_human" | "failed";

export interface AgentRunResult {
  runId: string;
  provider: "policy" | "anthropic";
  trigger: Trigger;
  status: RunStatus;
  decision: Decision;
  trace: TraceEvent[];
  audit: FinalAudit;
  writeErrors: RunContext["writeErrors"];
  endState: {
    purchaseOrders: ReturnType<MockErp["listPos"]>;
    approvals: ReturnType<MockErp["listApprovals"]>;
    escalations: ReturnType<MockErp["listEscalations"]>;
  };
  durationMs: number;
}

export interface Planner {
  readonly name: "policy" | "anthropic";
  run(ctx: RunContext, tools: import("../tools/registry.ts").ToolRegistry): Promise<Decision>;
}

export type { MockErp };
