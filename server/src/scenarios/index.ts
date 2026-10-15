import type { DecisionAction, ErpState, FaultPlan, Trigger } from "../domain/types.ts";
import { addDays } from "../domain/dates.ts";
import { baseState, demand, inv, NODES, po, setSupplier, setTerms } from "../erp/seed.ts";
import type { AgentRunResult } from "../agent/types.ts";

export interface ScenarioExpectation {
  /** acceptable final decisions */
  decision: DecisionAction[];
  /** read tools the agent must have used: "did it obtain the necessary information?" */
  mustRead: string[];
  /** number of purchase orders the agent is expected to have created (non-cancelled) */
  poCount: { min: number; max: number };
  /** the agent must hand something to a human (escalation ticket and/or approval) */
  needsHuman: boolean;
  /** a fault is injected; the agent must observe a failed/mismatched write and still converge */
  recovery: boolean;
  /** extra scenario-specific assertions on the final state; return failure messages */
  check?: (r: AgentRunResult) => string[];
}

export interface Scenario {
  id: string;
  group: "S1" | "S2" | "S3" | "S4";
  title: string;
  description: string;
  trigger: Trigger;
  build: () => ErpState;
  faults?: FaultPlan;
  expect: ScenarioExpectation;
}

const TODAY = process.env.SIM_DATE ?? "2026-10-14";
const { main, dark } = NODES;
const READ_CORE = ["get_inventory", "get_demand_and_sales", "get_open_purchase_orders", "get_supplier_options", "get_budget", "get_storage_capacity"];

const created = (r: AgentRunResult) => r.endState.purchaseOrders.filter((p) => p.createdBy === "agent" && p.status !== "cancelled");
const qtyOf = (r: AgentRunResult) => created(r).reduce((a, p) => a + p.qty, 0);
const between = (label: string, n: number, lo: number, hi: number) => (n >= lo && n <= hi ? [] : [`${label}: expected ${lo}-${hi}, got ${n}`]);

// ---- shared state builders -------------------------------------------------------------------

function riceState(opts: { onHand: number; openPo?: number; forecastAge?: number; grocery?: number }): ErpState {
  const s = baseState(TODAY);
  s.inventory.push(inv("RICE-5KG", main, opts.onHand, TODAY));
  s.demand.push(demand({ sku: "RICE-5KG", node: main, baselineDaily: 40, forecastAgeDays: opts.forecastAge ?? 2 }));
  if (opts.openPo) s.purchaseOrders.push(po(TODAY, { id: "PO-800", sku: "RICE-5KG", node: main, supplierId: "SUP-AGRO", qty: opts.openPo, unitCost: 4.0 }, 5));
  if (opts.grocery !== undefined) s.budgets.find((b) => b.category === "grocery")!.remainingUsd = opts.grocery;
  return s;
}

function milkShortfallState(opts: { onHand: number; freshActive?: boolean }): ErpState {
  const s = baseState(TODAY);
  s.inventory.push(inv("MILK-1L", main, opts.onHand, TODAY));
  s.demand.push(demand({ sku: "MILK-1L", node: main, baselineDaily: 120 }));
  s.purchaseOrders.push(po(TODAY, { id: "PO-900", sku: "MILK-1L", node: main, supplierId: "SUP-AGRO", qty: 500, confirmedQty: 250, unitCost: 1.0, eta: addDays(TODAY, 3) }, 3));
  // The supplier has told us it is capacity-constrained: new orders are capped too.
  setTerms(s, "SUP-AGRO", "MILK-1L", { maxQtyPerOrder: 250 });
  if (opts.freshActive === false) setSupplier(s, "SUP-FRESH", { active: false });
  return s;
}

function waterState(sales: number[], opts: { onHand: number; openPo?: number } ): ErpState {
  const s = baseState(TODAY);
  s.inventory.push(inv("WATER-6PK", main, opts.onHand, TODAY));
  s.demand.push(demand({ sku: "WATER-6PK", node: main, baselineDaily: 60, dailySales: sales }));
  if (opts.openPo) s.purchaseOrders.push(po(TODAY, { id: "PO-810", sku: "WATER-6PK", node: main, supplierId: "SUP-FRESH", qty: opts.openPo, unitCost: 2.5, eta: addDays(TODAY, 4) }, 4));
  return s;
}

// ---- scenarios -------------------------------------------------------------------------------

export const scenarios: Scenario[] = [
  {
    id: "s1-modify-overbuy",
    group: "S1",
    title: "System recommends 800 units but open PO + stock already cover most of it",
    description: "Recommendation ignores the 200 units already inbound. The agent should shrink the order to what is actually needed.",
    trigger: { type: "review_recommendation", sku: "RICE-5KG", node: main, recommendedQty: 800, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 160, openPo: 200 }),
    expect: {
      decision: ["modify"],
      mustRead: [...READ_CORE, "get_open_purchase_orders"],
      poCount: { min: 1, max: 1 },
      needsHuman: false,
      recovery: false,
      check: (r) => between("ordered qty", qtyOf(r), 160, 180),
    },
  },
  {
    id: "s1-accept-correct",
    group: "S1",
    title: "Recommendation of 170 units is right and should be accepted",
    description: "A correct recommendation must not be second-guessed: the agent executes it as-is.",
    trigger: { type: "review_recommendation", sku: "RICE-5KG", node: main, recommendedQty: 170, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 160, openPo: 200 }),
    expect: { decision: ["accept"], mustRead: READ_CORE, poCount: { min: 1, max: 1 }, needsHuman: false, recovery: false, check: (r) => between("ordered qty", qtyOf(r), 170, 170) },
  },
  {
    id: "s1-reject-no-need",
    group: "S1",
    title: "Recommendation of 800 units but stock + inbound already exceed target",
    description: "Position is above the target level, so buying anything would create excess stock: reject.",
    trigger: { type: "review_recommendation", sku: "RICE-5KG", node: main, recommendedQty: 800, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 600, openPo: 200 }),
    expect: { decision: ["reject"], mustRead: READ_CORE, poCount: { min: 0, max: 0 }, needsHuman: false, recovery: false },
  },
  {
    id: "s1-investigate-stale-forecast",
    group: "S1",
    title: "Recommendation relies on a 30-day-old forecast",
    description: "The agent should not execute (or reject) on untrustworthy input: it investigates and raises a data-quality ticket.",
    trigger: { type: "review_recommendation", sku: "RICE-5KG", node: main, recommendedQty: 800, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 160, openPo: 200, forecastAge: 30 }),
    expect: { decision: ["investigate"], mustRead: READ_CORE, poCount: { min: 0, max: 0 }, needsHuman: true, recovery: false },
  },
  {
    id: "s2-alternate-supplier",
    group: "S2",
    title: "PO of 500 units: supplier ships only 250",
    description: "Stock + 250 inbound will run out before the next replenishment. The agent sources the gap from the alternate supplier.",
    trigger: { type: "supplier_shortfall", poId: "PO-900", requestedQty: 500, confirmedQty: 250 },
    build: () => milkShortfallState({ onHand: 400 }),
    expect: {
      decision: ["modify"],
      mustRead: ["get_purchase_order", ...READ_CORE],
      poCount: { min: 1, max: 1 },
      needsHuman: false,
      recovery: false,
      check: (r) => [
        ...between("ordered qty", qtyOf(r), 780, 840),
        ...(created(r).every((p) => p.supplierId === "SUP-FRESH") ? [] : ["gap should be sourced from the alternate supplier SUP-FRESH"]),
      ],
    },
  },
  {
    id: "s2-stock-sufficient",
    group: "S2",
    title: "Supplier ships 250 of 500 but we hold plenty of stock",
    description: "No new PO is needed. Buying a replacement would just create excess stock.",
    trigger: { type: "supplier_shortfall", poId: "PO-900", requestedQty: 500, confirmedQty: 250 },
    build: () => milkShortfallState({ onHand: 1500 }),
    expect: { decision: ["accept", "no_action"], mustRead: ["get_purchase_order", ...READ_CORE], poCount: { min: 0, max: 0 }, needsHuman: false, recovery: false },
  },
  {
    id: "s2-no-alternative-escalate",
    group: "S2",
    title: "Supplier short-ships, stock-out is imminent and there is no alternate supplier",
    description: "Only a partial late mitigation is possible. The agent places what it can and escalates with high severity.",
    trigger: { type: "supplier_shortfall", poId: "PO-900", requestedQty: 500, confirmedQty: 250 },
    build: () => milkShortfallState({ onHand: 100, freshActive: false }),
    expect: {
      decision: ["escalate"],
      mustRead: ["get_purchase_order", ...READ_CORE],
      poCount: { min: 0, max: 1 },
      needsHuman: true,
      recovery: false,
      check: (r) => (r.endState.escalations.some((e) => e.severity === "high") ? [] : ["expected a high severity escalation"]),
    },
  },
  {
    id: "s3-sustained-demand-increase",
    group: "S3",
    title: "Sales running ~50% above baseline for a week",
    description: "Evidence (7 of 7 days elevated, not one outlier) supports raising the plan: add a top-up PO.",
    trigger: { type: "demand_change", sku: "WATER-6PK", node: main },
    build: () => waterState([58, 61, 60, 59, 62, 60, 61, 82, 85, 90, 88, 95, 92, 97], { onHand: 300, openPo: 400 }),
    expect: {
      decision: ["modify"],
      mustRead: ["get_demand_and_sales", "get_inventory", "get_open_purchase_orders", "get_supplier_options"],
      poCount: { min: 1, max: 1 },
      needsHuman: false,
      recovery: false,
      check: (r) => between("top-up qty", qtyOf(r), 340, 400),
    },
  },
  {
    id: "s3-one-day-spike",
    group: "S3",
    title: "One huge sales day (210) but otherwise normal",
    description: "A single outlier is not a trend. The agent must not extrapolate it into a big order.",
    trigger: { type: "demand_change", sku: "WATER-6PK", node: main },
    build: () => waterState([59, 61, 60, 58, 62, 60, 61, 60, 62, 59, 210, 61, 60, 58], { onHand: 400, openPo: 400 }),
    expect: { decision: ["no_action"], mustRead: ["get_demand_and_sales", "get_inventory", "get_open_purchase_orders"], poCount: { min: 0, max: 0 }, needsHuman: false, recovery: false },
  },
  {
    id: "s4-budget-constraint",
    group: "S4",
    title: "Purchase needed but only $900 of budget is left",
    description: "The agent buys what the budget allows, notes that the cheaper supplier is blocked by its MOQ, and escalates the rest.",
    trigger: { type: "purchase_needed", sku: "RICE-5KG", node: main, qty: 310, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 220, grocery: 900 }),
    expect: {
      decision: ["modify"],
      mustRead: READ_CORE,
      poCount: { min: 1, max: 1 },
      needsHuman: true,
      recovery: false,
      check: (r) => [...between("ordered qty", qtyOf(r), 200, 225), ...(r.endState.escalations.length ? [] : ["expected an escalation for the unfunded remainder"])],
    },
  },
  {
    id: "s4-storage-constraint",
    group: "S4",
    title: "Purchase needed but the dark store only has room for 240 units",
    description: "Storage, not money, is binding. The agent buys what fits and escalates.",
    trigger: { type: "purchase_needed", sku: "WATER-6PK", node: dark, qty: 480, supplierId: "SUP-FRESH" },
    build: () => {
      const s = baseState(TODAY);
      s.inventory.push(inv("WATER-6PK", dark, 250, TODAY));
      s.demand.push(demand({ sku: "WATER-6PK", node: dark, baselineDaily: 60 }));
      s.storage.find((x) => x.node === dark)!.otherUsedM3 = 55.1;
      return s;
    },
    expect: {
      decision: ["modify"],
      mustRead: READ_CORE,
      poCount: { min: 1, max: 1 },
      needsHuman: true,
      recovery: false,
      check: (r) => between("ordered qty", qtyOf(r), 216, 240),
    },
  },
  {
    id: "s4-approval-required",
    group: "S4",
    title: "Purchase is correct but worth $5,580, above the $5,000 auto-approve limit",
    description: "The agent prepares the PO but must not commit it: it goes to the human approval queue.",
    trigger: { type: "purchase_needed", sku: "WATER-6PK", node: main, qty: 2232, supplierId: "SUP-FRESH" },
    build: () => {
      const s = baseState(TODAY);
      s.inventory.push(inv("WATER-6PK", main, 800, TODAY));
      s.demand.push(demand({ sku: "WATER-6PK", node: main, baselineDaily: 250 }));
      return s;
    },
    expect: {
      decision: ["accept"],
      mustRead: READ_CORE,
      poCount: { min: 1, max: 1 },
      needsHuman: true,
      recovery: false,
      check: (r) => [
        ...(created(r).every((p) => p.status === "pending_approval") ? [] : ["PO above the limit must be pending_approval, not open"]),
        ...(r.endState.approvals.length === 1 ? [] : ["expected exactly one approval request"]),
      ],
    },
  },
  {
    id: "s4-fault-supplier-rejects-order",
    group: "S4",
    title: "ERP rejects the first PO: supplier can only ship 150 on a new order",
    description: "Initial action fails. The agent must read the error, learn the cap, re-plan and cover the rest elsewhere.",
    trigger: { type: "purchase_needed", sku: "RICE-5KG", node: main, qty: 310, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 220 }),
    faults: { rejectNextCreate: { maxQty: 150 } },
    expect: {
      decision: ["modify"],
      mustRead: READ_CORE,
      poCount: { min: 2, max: 2 },
      needsHuman: false,
      recovery: true,
      check: (r) => (r.audit.coverage.covered ? [] : ["final coverage must be restored after recovery"]),
    },
  },
  {
    id: "s4-fault-silent-partial-write",
    group: "S4",
    title: "ERP silently stores 60% of the quantity requested",
    description: "The write call 'succeeds' but the PO is wrong. Read-back verification must catch it and the agent must top up.",
    trigger: { type: "purchase_needed", sku: "RICE-5KG", node: main, qty: 310, supplierId: "SUP-AGRO" },
    build: () => riceState({ onHand: 220 }),
    faults: { silentTrimNextCreate: { factor: 0.6 } },
    expect: {
      decision: ["accept", "modify"],
      mustRead: READ_CORE,
      poCount: { min: 2, max: 2 },
      needsHuman: false,
      recovery: true,
      check: (r) => [
        ...(r.trace.some((e) => e.kind === "verification" && !e.ok) ? [] : ["verification should have flagged the mismatch"]),
        ...(r.audit.coverage.covered ? [] : ["final coverage must be restored after recovery"]),
      ],
    },
  },
];

export const getScenario = (id: string) => scenarios.find((s) => s.id === id);
