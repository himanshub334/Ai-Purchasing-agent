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
    escalations: Array<{ id: string; severity: string; summary: string; recommendedNextStep: string; status?: string }>;
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

export interface PairRow {
  sku: string; node: string; name: string; onHand: number; dailyDemand: number; demandNote: string;
  incoming: number; pendingApprovalQty: number; position: number; target: number; reorderPoint: number;
  daysOfCover: number; stockoutDay: number | null; health: "healthy" | "needs_order" | "critical" | "excess";
  blockedByEscalation: boolean; surge: number;
}

export type FeedItem =
  | { seq: number; simDate: string; kind: "world" | "human"; text: string }
  | { seq: number; simDate: string; kind: "agent"; text: string; runId: string; poIds: string[]; issueType: string; sku: string; node: string; decision: string; status: string; needsHuman: boolean };
export type AgentFeedItem = Extract<FeedItem, { kind: "agent" }>;

export interface Order extends Po {
  name: string; supplierName: string; valueUsd: number; runId: string | null; createdAt: string;
}
export interface Approval { id: string; poId: string; reason: string; valueUsd: number; status: string }
export interface Escalation { id: string; sku: string; node: string; severity: "low" | "medium" | "high"; summary: string; recommendedNextStep: string; status: "open" | "resolved"; createdAt: string }
export type Mode = "autonomous" | "approve_all" | "paused";

export interface Workspace {
  simDate: string;
  busy: boolean;
  autopilot: { enabled: boolean; intervalMs: number; provider: string };
  settings: { mode: Mode; autoApproveLimitUsd: number };
  rows: PairRow[];
  purchaseOrders: Po[];
  orders: Order[];
  approvals: Approval[];
  escalations: Escalation[];
  budgets: Array<{ category: string; remainingUsd: number }>;
  storage: Array<{ node: string; capacityM3: number; usedM3: number; reservedIncomingM3: number; freeM3: number }>;
  feed: FeedItem[];
  products: Array<{ sku: string; name: string; category: string }>;
  nodes: string[];
  nodeNames: Record<string, string>;
}

export interface SupplierOption {
  supplierId: string; supplierName: string; active: boolean; reliability: number; unitCost: number;
  leadTimeDays: number; moq: number; casePack: number; maxQtyPerOrder: number | null; arrivesAfterStockout: boolean;
}
export interface ItemDetail {
  row: PairRow;
  product: { sku: string; name: string; category: string; unitVolumeM3: number };
  salesLast14Days: number[]; baselineDaily: number; forecastDaily: number; forecastAgeDays: number; demandNotes: string[];
  options: SupplierOption[];
  suggestion: { supplierId: string; supplierName: string; qty: number; valueUsd: number; reason: string } | null;
  budgetRemainingUsd: number; storageFreeM3: number;
  orders: Order[];
  activity: AgentFeedItem[];
}
export interface SupplierView {
  id: string; name: string; active: boolean; reliability: number;
  items: Array<{ sku: string; name: string; unitCost: number; leadTimeDays: number; moq: number; casePack: number; maxQtyPerOrder: number | null }>;
  openOrders: number; openValueUsd: number; receivedOrders: number; shortShipped: number;
}
export interface OrderResult { po: Po; findings: Finding[]; workspace: Workspace }
