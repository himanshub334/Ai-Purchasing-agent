import type { EvalReport, Health, RunResult, ScenarioInfo } from "./types";

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
};
