export interface ScenarioInfo {
  id: string;
  group: "S1" | "S2" | "S3" | "S4";
  title: string;
  description: string;
  trigger: Record<string, unknown> & { type: string };
  faults: Record<string, unknown> | null;
  expectedDecision: string[];
}

export interface Finding { code: string; severity: "violation" | "warning"; message: string }

export type TraceEvent =
  | { kind: "tool"; step: number; tool: string; write: boolean; input: unknown; ok: boolean; output: unknown; ms: number }
  | { kind: "verification"; step: number; poId: string; expected?: unknown; ok: boolean; findings: Finding[] }
  | { kind: "thought"; step: number; text: string }
  | { kind: "recovery"; step: number; text: string };

export interface Po {
  id: string; sku: string; node: string; supplierId: string; qty: number; confirmedQty: number;
  unitCost: number; status: string; eta: string; createdBy: string; note?: string;
}

export interface RunResult {
  runId: string;
  provider: string;
  trigger: ScenarioInfo["trigger"];
  status: "completed" | "needs_human" | "failed";
  decision: { action: string; summary: string; rationale: string[]; actionsTaken: string[]; risks: string[]; needsHuman: boolean };
  trace: TraceEvent[];
  audit: {
    coverage: { covered: boolean; stockoutDay: number | null; position: number; target: number; shortfall: number };
    poValidations: Array<{ poId: string; ok: boolean; findings: Finding[] }>;
    unverifiedWrites: number;
  };
  writeErrors: Array<{ tool: string; code: string; message: string }>;
  endState: {
    purchaseOrders: Po[];
    approvals: Array<{ id: string; poId: string; reason: string; valueUsd: number; status: string }>;
    escalations: Array<{ id: string; severity: string; summary: string; recommendedNextStep: string }>;
  };
  durationMs: number;
}

export interface EvalReport {
  planner: string;
  passed: number;
  total: number;
  reports: Array<{
    id: string; group: string; title: string; pass: boolean; decision: string; summary: string; durationMs: number;
    dimensions: Record<string, { pass: boolean; detail: string }>;
  }>;
}

export interface Health { ok: boolean; provider: string; anthropicConfigured: boolean; simDate: string }
