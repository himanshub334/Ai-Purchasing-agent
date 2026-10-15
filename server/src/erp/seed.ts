import type { DemandInfo, ErpState, InventoryRecord, PurchaseOrder, Supplier, SupplierTerms } from "../domain/types.ts";
import { addDays } from "../domain/dates.ts";

/**
 * Mock dataset for a quick-commerce retailer: two fulfilment nodes, a handful of SKUs, and
 * suppliers with different lead times / MOQs / reliabilities. Scenarios start from this base
 * and override only what makes the situation interesting.
 */
export const NODES = { main: "FC-BLR-01", dark: "DS-BLR-07" } as const;

export function baseState(today: string): ErpState {
  return {
    today,
    products: [
      { sku: "RICE-5KG", name: "Basmati Rice 5kg", category: "grocery", unitVolumeM3: 0.012 },
      { sku: "MILK-1L", name: "UHT Milk 1L", category: "dairy", unitVolumeM3: 0.0015 },
      { sku: "WATER-6PK", name: "Mineral Water 6-pack", category: "beverages", unitVolumeM3: 0.01 },
      { sku: "NOODLE-4PK", name: "Instant Noodles 4-pack", category: "grocery", unitVolumeM3: 0.004 },
    ],
    suppliers: [
      { id: "SUP-AGRO", name: "AgroFoods Ltd", active: true, reliability: 0.96 },
      { id: "SUP-FRESH", name: "FreshChain Distributors", active: true, reliability: 0.9 },
      { id: "SUP-BULK", name: "BulkMart Wholesale", active: true, reliability: 0.82 },
    ],
    terms: [
      { supplierId: "SUP-AGRO", sku: "RICE-5KG", unitCost: 4.0, leadTimeDays: 5, moq: 100, casePack: 10, maxQtyPerOrder: 5000 },
      { supplierId: "SUP-BULK", sku: "RICE-5KG", unitCost: 3.6, leadTimeDays: 8, moq: 300, casePack: 20, maxQtyPerOrder: 5000 },
      { supplierId: "SUP-AGRO", sku: "MILK-1L", unitCost: 1.0, leadTimeDays: 3, moq: 200, casePack: 20, maxQtyPerOrder: 5000 },
      { supplierId: "SUP-FRESH", sku: "MILK-1L", unitCost: 1.1, leadTimeDays: 4, moq: 200, casePack: 20, maxQtyPerOrder: 1000 },
      { supplierId: "SUP-FRESH", sku: "WATER-6PK", unitCost: 2.5, leadTimeDays: 4, moq: 100, casePack: 12, maxQtyPerOrder: 6000 },
      { supplierId: "SUP-BULK", sku: "WATER-6PK", unitCost: 2.7, leadTimeDays: 6, moq: 120, casePack: 12, maxQtyPerOrder: 6000 },
      { supplierId: "SUP-AGRO", sku: "NOODLE-4PK", unitCost: 1.8, leadTimeDays: 4, moq: 100, casePack: 10, maxQtyPerOrder: 4000 },
    ],
    inventory: [],
    demand: [],
    purchaseOrders: [],
    budgets: [
      { category: "grocery", remainingUsd: 20_000 },
      { category: "dairy", remainingUsd: 8_000 },
      { category: "beverages", remainingUsd: 12_000 },
    ],
    storage: [
      { node: NODES.main, capacityM3: 400, otherUsedM3: 250 },
      { node: NODES.dark, capacityM3: 60, otherUsedM3: 40 },
    ],
    approvals: [],
    escalations: [],
  };
}

export function steadySales(daily: number, jitter = 3): number[] {
  const pattern = [0, 2, -2, 1, -1, 3, -3, 1, -2, 2, 0, -1, 1, -1];
  return pattern.map((p) => Math.max(0, Math.round(daily + (p * jitter) / 3)));
}

export function demand(p: Partial<DemandInfo> & Pick<DemandInfo, "sku" | "node" | "baselineDaily">): DemandInfo {
  return {
    forecastDaily: p.baselineDaily,
    stdDaily: Math.round(p.baselineDaily * 0.2),
    dailySales: steadySales(p.baselineDaily),
    forecastAgeDays: 2,
    promoActive: false,
    ...p,
  };
}

export function inv(sku: string, node: string, onHand: number, today: string): InventoryRecord {
  return { sku, node, onHand, countedAt: today };
}

export function po(today: string, p: Partial<PurchaseOrder> & Pick<PurchaseOrder, "id" | "sku" | "node" | "supplierId" | "qty" | "unitCost">, leadDays: number): PurchaseOrder {
  return {
    confirmedQty: p.qty,
    status: "open",
    createdAt: addDays(today, -(Math.max(0, leadDays - 3))),
    eta: addDays(today, 3),
    createdBy: "system",
    ...p,
  };
}

export function setSupplier(state: ErpState, id: string, patch: Partial<Supplier>) {
  const s = state.suppliers.find((x) => x.id === id)!;
  Object.assign(s, patch);
}

export function setTerms(state: ErpState, supplierId: string, sku: string, patch: Partial<SupplierTerms>) {
  const t = state.terms.find((x) => x.supplierId === supplierId && x.sku === sku)!;
  Object.assign(t, patch);
}

/**
 * The "live" workspace dataset: five SKU x node pairs in different health states so the monitor
 * has something to find on day 1 and the simulated days keep creating new situations.
 */
export function workspaceState(today: string): ErpState {
  const s = baseState(today);
  const { main, dark } = NODES;
  s.products.push();
  s.terms.push({ supplierId: "SUP-BULK", sku: "NOODLE-4PK", unitCost: 1.6, leadTimeDays: 7, moq: 400, casePack: 20, maxQtyPerOrder: 6000 });
  s.storage.find((x) => x.node === dark)!.otherUsedM3 = 52;

  const pairs: Array<[string, string, number, number]> = [
    // sku, node, baseline demand/day, on hand
    ["RICE-5KG", main, 40, 300], // healthy, inbound PO
    ["MILK-1L", main, 120, 420], // needs an order today
    ["WATER-6PK", main, 60, 650], // healthy, inbound PO
    ["NOODLE-4PK", main, 30, 1200], // excess
    ["WATER-6PK", dark, 40, 150], // low, tight storage
  ];
  for (const [sku, node, base, onHand] of pairs) {
    s.inventory.push(inv(sku, node, onHand, today));
    s.demand.push(demand({ sku, node, baselineDaily: base }));
  }
  s.purchaseOrders.push(
    { id: "PO-0001", sku: "RICE-5KG", node: main, supplierId: "SUP-AGRO", qty: 200, confirmedQty: 200, unitCost: 4.0, status: "open", createdAt: addDays(today, -3), eta: addDays(today, 2), createdBy: "system" },
    { id: "PO-0002", sku: "WATER-6PK", node: main, supplierId: "SUP-FRESH", qty: 400, confirmedQty: 400, unitCost: 2.5, status: "open", createdAt: addDays(today, -1), eta: addDays(today, 3), createdBy: "buyer" },
  );
  return s;
}
