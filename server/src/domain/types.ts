// Core domain model shared by the mock ERP, the agent tools, the validator and the evals.

export type Sku = string;
export type NodeId = string;
export type ISODate = string; // YYYY-MM-DD

export interface Product {
  sku: Sku;
  name: string;
  category: string;
  /** m3 per unit, used for storage constraints */
  unitVolumeM3: number;
}

export interface Supplier {
  id: string;
  name: string;
  active: boolean;
  /** share of historical POs delivered in full and on time (0..1) */
  reliability: number;
}

/** Commercial terms of one supplier for one SKU. */
export interface SupplierTerms {
  supplierId: string;
  sku: Sku;
  unitCost: number;
  leadTimeDays: number;
  moq: number;
  casePack: number;
  /** hard ceiling per order (supplier capacity), if any */
  maxQtyPerOrder?: number;
}

export interface InventoryRecord {
  sku: Sku;
  node: NodeId;
  onHand: number;
  countedAt: ISODate;
}

export interface DemandInfo {
  sku: Sku;
  node: NodeId;
  /** long-run normal demand, units/day */
  baselineDaily: number;
  /** what the planning system currently forecasts, units/day */
  forecastDaily: number;
  /** std-dev of daily demand */
  stdDaily: number;
  /** actual sales for the last 14 days, oldest first */
  dailySales: number[];
  forecastAgeDays: number;
  promoActive: boolean;
}

export type PoStatus =
  | "pending_approval"
  | "open"
  | "received"
  | "cancelled";

export interface PurchaseOrder {
  id: string;
  sku: Sku;
  node: NodeId;
  supplierId: string;
  /** quantity originally ordered */
  qty: number;
  /** quantity the supplier has confirmed it can ship (defaults to qty) */
  confirmedQty: number;
  unitCost: number;
  status: PoStatus;
  createdAt: ISODate;
  eta: ISODate;
  createdBy: "system" | "agent" | "buyer";
  note?: string;
}

export interface Budget {
  category: string;
  remainingUsd: number;
}

export interface StorageInfo {
  node: NodeId;
  capacityM3: number;
  /** volume used by SKUs that are not modelled in this dataset */
  otherUsedM3: number;
}

export interface ApprovalRequest {
  id: string;
  poId: string;
  reason: string;
  valueUsd: number;
  status: "pending" | "approved" | "rejected";
  createdAt: ISODate;
}

export interface Escalation {
  id: string;
  sku: Sku;
  node: NodeId;
  severity: "low" | "medium" | "high";
  summary: string;
  recommendedNextStep: string;
  createdAt: ISODate;
  /** open until a human acknowledges it; the monitor does not re-run the agent on a pair with an open escalation */
  status: "open" | "resolved";
}

export interface ErpState {
  today: ISODate;
  products: Product[];
  suppliers: Supplier[];
  terms: SupplierTerms[];
  inventory: InventoryRecord[];
  demand: DemandInfo[];
  purchaseOrders: PurchaseOrder[];
  budgets: Budget[];
  storage: StorageInfo[];
  approvals: ApprovalRequest[];
  escalations: Escalation[];
}

/** Faults a scenario can inject into the ERP to exercise the feedback loop. */
export interface FaultPlan {
  /** the next createPO call is rejected with SUPPLIER_CAPACITY; maxQty is reported back */
  rejectNextCreate?: { maxQty: number };
  /** the next createPO silently stores a smaller qty than requested (a partial write) */
  silentTrimNextCreate?: { factor: number };
}

export interface PlanParams {
  reviewPeriodDays: number;
  serviceLevelZ: number;
  excessCoverFactor: number;
  autoApproveLimitUsd: number;
  /** hard ceiling on the value of orders one agent run may create, independent of the approval limit */
  runValueCapUsd?: number;
}

// ---- Triggers: the "purchasing situations" handed to the agent ----

export type Trigger =
  | { type: "review_recommendation"; sku: Sku; node: NodeId; recommendedQty: number; supplierId?: string }
  | { type: "supplier_shortfall"; poId: string; requestedQty: number; confirmedQty: number }
  | { type: "demand_change"; sku: Sku; node: NodeId }
  | { type: "purchase_needed"; sku: Sku; node: NodeId; qty: number; supplierId?: string };

export type DecisionAction =
  | "accept"
  | "modify"
  | "reject"
  | "investigate"
  | "escalate"
  | "no_action";

export interface Decision {
  action: DecisionAction;
  summary: string;
  rationale: string[];
  /** human readable list of what the agent did in the ERP */
  actionsTaken: string[];
  risks: string[];
  needsHuman: boolean;
}
