import { addDays } from "../domain/dates.ts";
import type {
  ApprovalRequest,
  Budget,
  DemandInfo,
  Escalation,
  ErpState,
  FaultPlan,
  InventoryRecord,
  NodeId,
  PurchaseOrder,
  Sku,
  StorageInfo,
  Supplier,
  SupplierTerms,
  Product,
} from "../domain/types.ts";

export class ErpError extends Error {
  constructor(
    public code:
      | "NOT_FOUND"
      | "INVALID"
      | "SUPPLIER_INACTIVE"
      | "SUPPLIER_CAPACITY"
      | "BELOW_MOQ"
      | "CASE_PACK"
      | "BUDGET_EXCEEDED"
      | "STORAGE_EXCEEDED"
      | "BAD_STATE",
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface CreatePoInput {
  sku: Sku;
  node: NodeId;
  supplierId: string;
  qty: number;
  createdBy: PurchaseOrder["createdBy"];
  note?: string;
  /** when true the PO is stored as pending_approval and does not consume budget/storage */
  requiresApproval?: boolean;
  approvalReason?: string;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory mock ERP / purchasing system. It enforces the *hard* business rules a real ERP
 * would (MOQ, case pack, supplier capacity, budget, storage) and can inject faults so we can
 * test the agent's feedback loop. It deliberately exposes a small, narrow API: the agent never
 * touches the state directly, only through tools that call these methods.
 */
export class MockErp {
  private state: ErpState;
  private faults: FaultPlan;
  private seq = 1000;

  constructor(initial: ErpState, faults: FaultPlan = {}) {
    this.state = clone(initial);
    this.faults = { ...faults };
  }

  // ---- reads --------------------------------------------------------------------------------

  today() {
    return this.state.today;
  }
  getProduct(sku: Sku): Product {
    return clone(this.must(this.state.products.find((p) => p.sku === sku), `product ${sku}`));
  }
  getSupplier(id: string): Supplier {
    return clone(this.must(this.state.suppliers.find((s) => s.id === id), `supplier ${id}`));
  }
  listTerms(sku: Sku): SupplierTerms[] {
    return clone(this.state.terms.filter((t) => t.sku === sku));
  }
  getTerms(sku: Sku, supplierId: string): SupplierTerms {
    return clone(
      this.must(
        this.state.terms.find((t) => t.sku === sku && t.supplierId === supplierId),
        `terms ${supplierId}/${sku}`,
      ),
    );
  }
  getInventory(sku: Sku, node: NodeId): InventoryRecord {
    return clone(
      this.must(this.state.inventory.find((i) => i.sku === sku && i.node === node), `inventory ${sku}@${node}`),
    );
  }
  getDemand(sku: Sku, node: NodeId): DemandInfo {
    return clone(this.must(this.state.demand.find((d) => d.sku === sku && d.node === node), `demand ${sku}@${node}`));
  }
  getPo(id: string): PurchaseOrder {
    return clone(this.must(this.state.purchaseOrders.find((p) => p.id === id), `PO ${id}`));
  }
  listPos(filter: { sku?: Sku; node?: NodeId } = {}): PurchaseOrder[] {
    return clone(
      this.state.purchaseOrders.filter(
        (p) => (!filter.sku || p.sku === filter.sku) && (!filter.node || p.node === filter.node),
      ),
    );
  }
  getBudget(category: string): Budget {
    return clone(this.must(this.state.budgets.find((b) => b.category === category), `budget ${category}`));
  }
  getStorage(node: NodeId): StorageInfo & { usedM3: number; reservedIncomingM3: number; freeM3: number } {
    const s = this.must(this.state.storage.find((x) => x.node === node), `storage ${node}`);
    const onHandVol = this.state.inventory
      .filter((i) => i.node === node)
      .reduce((a, i) => a + i.onHand * this.getProduct(i.sku).unitVolumeM3, 0);
    const incoming = this.state.purchaseOrders
      .filter((p) => p.node === node && p.status === "open")
      .reduce((a, p) => a + p.confirmedQty * this.getProduct(p.sku).unitVolumeM3, 0);
    const used = s.otherUsedM3 + onHandVol;
    return { ...clone(s), usedM3: round(used), reservedIncomingM3: round(incoming), freeM3: round(s.capacityM3 - used - incoming) };
  }
  listApprovals(): ApprovalRequest[] {
    return clone(this.state.approvals);
  }
  listEscalations(): Escalation[] {
    return clone(this.state.escalations);
  }
  snapshot(): ErpState {
    return clone(this.state);
  }

  // ---- writes -------------------------------------------------------------------------------

  createPo(input: CreatePoInput): PurchaseOrder {
    const terms = this.getTerms(input.sku, input.supplierId);
    const supplier = this.getSupplier(input.supplierId);
    if (!Number.isInteger(input.qty) || input.qty <= 0) throw new ErpError("INVALID", "qty must be a positive integer");
    if (!supplier.active) throw new ErpError("SUPPLIER_INACTIVE", `supplier ${supplier.id} is inactive`);
    if (input.qty < terms.moq) throw new ErpError("BELOW_MOQ", `qty ${input.qty} below MOQ ${terms.moq}`, { moq: terms.moq });
    if (input.qty % terms.casePack !== 0)
      throw new ErpError("CASE_PACK", `qty must be a multiple of case pack ${terms.casePack}`, { casePack: terms.casePack });

    if (this.faults.rejectNextCreate) {
      const { maxQty } = this.faults.rejectNextCreate;
      this.faults.rejectNextCreate = undefined;
      throw new ErpError("SUPPLIER_CAPACITY", `supplier can currently ship at most ${maxQty} units on a new order`, { maxQty });
    }
    if (terms.maxQtyPerOrder !== undefined && input.qty > terms.maxQtyPerOrder)
      throw new ErpError("SUPPLIER_CAPACITY", `supplier max per order is ${terms.maxQtyPerOrder}`, { maxQty: terms.maxQtyPerOrder });

    let qty = input.qty;
    if (this.faults.silentTrimNextCreate) {
      const f = this.faults.silentTrimNextCreate.factor;
      this.faults.silentTrimNextCreate = undefined;
      qty = Math.max(terms.moq, Math.floor((qty * f) / terms.casePack) * terms.casePack);
    }

    const value = qty * terms.unitCost;
    const product = this.getProduct(input.sku);
    if (!input.requiresApproval) {
      const budget = this.getBudget(product.category);
      if (value > budget.remainingUsd + 1e-9)
        throw new ErpError("BUDGET_EXCEEDED", `PO value $${value.toFixed(2)} exceeds remaining budget $${budget.remainingUsd.toFixed(2)}`, {
          remainingUsd: budget.remainingUsd,
        });
      const storage = this.getStorage(input.node);
      const vol = qty * product.unitVolumeM3;
      if (vol > storage.freeM3 + 1e-9)
        throw new ErpError("STORAGE_EXCEEDED", `PO needs ${vol.toFixed(1)} m3 but only ${storage.freeM3} m3 free at ${input.node}`, {
          freeM3: storage.freeM3,
        });
    }

    const po: PurchaseOrder = {
      id: `PO-${++this.seq}`,
      sku: input.sku,
      node: input.node,
      supplierId: input.supplierId,
      qty,
      confirmedQty: qty,
      unitCost: terms.unitCost,
      status: input.requiresApproval ? "pending_approval" : "open",
      createdAt: this.state.today,
      eta: addDays(this.state.today, terms.leadTimeDays),
      createdBy: input.createdBy,
      note: input.note,
    };
    this.state.purchaseOrders.push(po);
    if (input.requiresApproval) {
      this.state.approvals.push({
        id: `APR-${++this.seq}`,
        poId: po.id,
        reason: input.approvalReason ?? "value above auto-approve limit",
        valueUsd: value,
        status: "pending",
        createdAt: this.state.today,
      });
    } else {
      this.deductBudget(product.category, value);
    }
    return clone(po);
  }

  /** Supplier tells us what it can actually ship. Used by scenario 2 and by the API. */
  setSupplierConfirmation(poId: string, confirmedQty: number): PurchaseOrder {
    const po = this.mustPo(poId);
    if (po.status !== "open") throw new ErpError("BAD_STATE", `PO ${poId} is ${po.status}`);
    const cat = this.getProduct(po.sku).category;
    const refund = (po.confirmedQty - confirmedQty) * po.unitCost;
    po.confirmedQty = confirmedQty;
    this.deductBudget(cat, -refund); // unconfirmed quantity releases budget
    return clone(po);
  }

  cancelPo(poId: string): PurchaseOrder {
    const po = this.mustPo(poId);
    if (po.status === "received" || po.status === "cancelled") throw new ErpError("BAD_STATE", `PO ${poId} is ${po.status}`);
    if (po.status === "open") this.deductBudget(this.getProduct(po.sku).category, -po.confirmedQty * po.unitCost);
    po.status = "cancelled";
    return clone(po);
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected"): PurchaseOrder {
    const a = this.must(this.state.approvals.find((x) => x.id === approvalId), `approval ${approvalId}`);
    const po = this.mustPo(a.poId);
    if (a.status !== "pending") throw new ErpError("BAD_STATE", `approval ${approvalId} already ${a.status}`);
    a.status = decision;
    if (decision === "rejected") {
      po.status = "cancelled";
      return clone(po);
    }
    const product = this.getProduct(po.sku);
    const value = po.qty * po.unitCost;
    const budget = this.getBudget(product.category);
    if (value > budget.remainingUsd) throw new ErpError("BUDGET_EXCEEDED", "budget no longer sufficient at approval time", { remainingUsd: budget.remainingUsd });
    po.status = "open";
    this.deductBudget(product.category, value);
    return clone(po);
  }

  createEscalation(e: Omit<Escalation, "id" | "createdAt" | "status">): Escalation {
    const esc: Escalation = { ...e, id: `ESC-${++this.seq}`, createdAt: this.state.today, status: "open" };
    this.state.escalations.push(esc);
    return clone(esc);
  }

  resolveEscalation(id: string): Escalation {
    const e = this.must(this.state.escalations.find((x) => x.id === id), `escalation ${id}`);
    e.status = "resolved";
    return clone(e);
  }

  /** A human releases extra budget for a category (used to unblock budget escalations). */
  addBudget(category: string, usd: number): Budget {
    if (!(usd > 0)) throw new ErpError("INVALID", "amount must be positive");
    this.deductBudget(category, -usd);
    return this.getBudget(category);
  }

  // ---- simulation clock -----------------------------------------------------------------------

  /** All SKU x node pairs that have both stock and demand records. */
  listPairs(): Array<{ sku: Sku; node: NodeId }> {
    return this.state.demand.filter((d) => this.state.inventory.some((i) => i.sku === d.sku && i.node === d.node)).map((d) => ({ sku: d.sku, node: d.node }));
  }

  /**
   * Advance the world by one day: inbound POs whose ETA has arrived are received (morning),
   * then the day's sales are taken from stock. Sales history rolls forward and the planning
   * forecast is refreshed weekly from the last 14 days, like a real planning system.
   */
  advanceDay(salesFor: (d: DemandInfo) => number): {
    date: string;
    received: Array<{ poId: string; sku: Sku; node: NodeId; qty: number }>;
    sales: Array<{ sku: Sku; node: NodeId; demand: number; sold: number; lost: number }>;
  } {
    this.state.today = addDays(this.state.today, 1);
    const received: Array<{ poId: string; sku: Sku; node: NodeId; qty: number }> = [];
    for (const po of this.state.purchaseOrders) {
      if (po.status === "open" && po.eta <= this.state.today) {
        const rec = this.state.inventory.find((i) => i.sku === po.sku && i.node === po.node);
        if (rec) rec.onHand += po.confirmedQty;
        po.status = "received";
        received.push({ poId: po.id, sku: po.sku, node: po.node, qty: po.confirmedQty });
      }
    }
    const sales = this.state.demand.map((d) => {
      const rec = this.state.inventory.find((i) => i.sku === d.sku && i.node === d.node);
      const units = Math.max(0, Math.round(salesFor(d)));
      const sold = rec ? Math.min(rec.onHand, units) : 0;
      if (rec) {
        rec.onHand -= sold;
        rec.countedAt = this.state.today;
      }
      d.dailySales = [...d.dailySales.slice(1), units];
      d.forecastAgeDays += 1;
      if (d.forecastAgeDays >= 7) {
        d.forecastDaily = Math.round(d.dailySales.reduce((a, b) => a + b, 0) / d.dailySales.length);
        d.forecastAgeDays = 0;
      }
      return { sku: d.sku, node: d.node, demand: units, sold, lost: units - sold };
    });
    return { date: this.state.today, received, sales };
  }

  // ---- internals ----------------------------------------------------------------------------

  private deductBudget(category: string, usd: number) {
    const b = this.must(this.state.budgets.find((x) => x.category === category), `budget ${category}`);
    b.remainingUsd = round(b.remainingUsd - usd);
  }
  private mustPo(id: string): PurchaseOrder {
    return this.must(this.state.purchaseOrders.find((p) => p.id === id), `PO ${id}`);
  }
  private must<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new ErpError("NOT_FOUND", `${what} not found`);
    return v;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
