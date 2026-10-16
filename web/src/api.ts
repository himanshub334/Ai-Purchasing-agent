import type { EvalReport, Health, ItemDetail, Mode, OrderResult, RunResult, ScenarioInfo, SupplierView, Workspace } from "./types";

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  health: () => fetch("/api/health").then((r) => j<Health>(r)),
  scenarios: () => fetch("/api/scenarios").then((r) => j<ScenarioInfo[]>(r)),
  run: (scenarioId: string, provider: string) => post("/api/runs", { scenarioId, provider }).then((r) => j<RunResult>(r)),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => j<RunResult>(r)),
  resolveApproval: (runId: string, approvalId: string, decision: "approved" | "rejected") =>
    post(`/api/runs/${runId}/approvals/${approvalId}`, { decision }).then((r) => j<unknown>(r)),
  evals: (provider: string) => post("/api/evals", { provider }).then((r) => j<EvalReport>(r)),
  workspace: () => fetch("/api/workspace").then((r) => j<Workspace>(r)),
  advance: (days: number, provider: string) => post("/api/workspace/advance", { days, provider }).then((r) => j<{ workspace: Workspace }>(r)).then((x) => x.workspace),
  scan: (provider: string) => post("/api/workspace/scan", { provider }).then((r) => j<{ workspace: Workspace }>(r)).then((x) => x.workspace),
  event: (e: Record<string, unknown>) => post("/api/workspace/events", e).then((r) => j<Workspace>(r)),
  autopilot: (enabled: boolean, intervalMs: number, provider: string) => post("/api/workspace/autopilot", { enabled, intervalMs, provider }).then((r) => j<Workspace>(r)),
  reset: () => post("/api/workspace/reset", {}).then((r) => j<Workspace>(r)),
  wsApproval: (id: string, decision: "approved" | "rejected") => post(`/api/workspace/approvals/${id}`, { decision }).then((r) => j<Workspace>(r)),
  wsResolve: (id: string) => post(`/api/workspace/escalations/${id}/resolve`, {}).then((r) => j<Workspace>(r)),
  wsRun: (id: string) => fetch(`/api/workspace/runs/${id}`).then((r) => j<RunResult>(r)),
  item: (sku: string, node: string) => fetch(`/api/workspace/items/${sku}/${node}`).then((r) => j<ItemDetail>(r)),
  suppliers: () => fetch("/api/workspace/suppliers").then((r) => j<SupplierView[]>(r)),
  settings: (s: { mode?: Mode; autoApproveLimitUsd?: number }) => post("/api/workspace/settings", s).then((r) => j<Workspace>(r)),
  placeOrder: (o: { sku: string; node: string; supplierId: string; qty: number }) => post("/api/workspace/orders", o).then((r) => j<OrderResult>(r)),
  cancelOrder: (id: string) => post(`/api/workspace/orders/${id}/cancel`, {}).then((r) => j<Workspace>(r)),
};
