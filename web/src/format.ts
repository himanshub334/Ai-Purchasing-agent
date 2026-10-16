import type { AgentFeedItem, Order, Workspace } from "./types";

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const usd2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const nodeName = (ws: Workspace, node: string) => ws.nodeNames[node] ?? node;
export const productName = (ws: Workspace, sku: string) => ws.products.find((p) => p.sku === sku)?.name ?? sku;

export const HEALTH = {
  healthy: { label: "Healthy", tone: "b-ok" },
  needs_order: { label: "Reorder due", tone: "b-warn" },
  critical: { label: "Stock-out risk", tone: "b-bad" },
  excess: { label: "Overstocked", tone: "b-info" },
} as const;

export const STATUS = {
  open: { label: "On order", tone: "b-ok" },
  pending_approval: { label: "Needs approval", tone: "b-warn" },
  received: { label: "Received", tone: "b-info" },
  cancelled: { label: "Cancelled", tone: "b-bad" },
} as Record<string, { label: string; tone: string }>;

export const SOURCE: Record<string, string> = { agent: "Agent", buyer: "You", system: "System" };

/** Plain-language outcome of one agent run, built from the orders it touched. */
export function agentHeadline(ws: Workspace, f: AgentFeedItem): { lines: string[]; tone: "done" | "waiting" | "attention" | "info" } {
  const orders = f.poIds.map((id) => ws.orders.find((o) => o.id === id)).filter((o): o is Order => Boolean(o) && o!.status !== "cancelled");
  const lines = orders.map((o) => {
    const where = nodeName(ws, o.node);
    return o.status === "pending_approval"
      ? `Prepared an order of ${o.qty} × ${o.name} from ${o.supplierName} for ${where} (${usd(o.valueUsd)}): waiting for your approval.`
      : `Ordered ${o.qty} × ${o.name} from ${o.supplierName} for ${where} (${usd(o.valueUsd)}), arriving ${shortDate(o.eta)}.`;
  });
  if (f.needsHuman) return { lines: [...lines, ...(lines.length ? [] : [f.text])], tone: "attention" };
  if (!lines.length) return { lines: [f.text], tone: "info" };
  return { lines, tone: orders.some((o) => o.status === "pending_approval") ? "waiting" : "done" };
}

export const TRIGGER_LABEL: Record<string, string> = {
  purchase_needed: "Stock reached its reorder point",
  supplier_shortfall: "A supplier can't ship the full order",
  demand_change: "Sales are running above plan",
  review_recommendation: "Recommendation review",
};
