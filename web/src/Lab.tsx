import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DecisionCard, EvalMatrix, StatePanel, Trace } from "./components";
import type { EvalReport, Health, RunResult, ScenarioInfo } from "./types";

const GROUP_LABEL: Record<string, string> = {
  S1: "S1 · Review a recommendation",
  S2: "S2 · Supplier cannot fulfil",
  S3: "S3 · Demand has changed",
  S4: "S4 · Purchasing constraint",
};

function triggerChips(t: ScenarioInfo["trigger"], faults: ScenarioInfo["faults"]) {
  const chips = Object.entries(t).map(([k, v]) => `${k}: ${v}`);
  if (faults) chips.push(`injected fault: ${Object.keys(faults)[0]}`);
  return chips;
}

export default function Lab() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [tab, setTab] = useState<"run" | "eval">("run");
  const [provider, setProvider] = useState("policy");
  const [run, setRun] = useState<RunResult | null>(null);
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.scenarios().then((s) => { setScenarios(s); setSelected(s[0]?.id ?? ""); }).catch((e) => setError(String(e.message)));
    api.health().then(setHealth).catch(() => undefined);
  }, []);

  const current = scenarios.find((s) => s.id === selected);
  const grouped = useMemo(() => {
    const m = new Map<string, ScenarioInfo[]>();
    for (const s of scenarios) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [scenarios]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);

  const runScenario = () => guard(async () => setRun(await api.run(selected, provider)));
  const runEvals = () => guard(async () => setEvalReport(await api.evals(provider)));
  const approve = (approvalId: string, d: "approved" | "rejected") =>
    guard(async () => { if (!run) return; await api.resolveApproval(run.runId, approvalId, d); setRun(await api.getRun(run.runId)); });

  const providerSelect = (
    <label className="muted">Agent{" "}
      <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent provider">
        <option value="policy">Deterministic policy agent (offline)</option>
        <option value="anthropic" disabled={health ? !health.anthropicConfigured : false}>Claude tool-use agent{health && !health.anthropicConfigured ? " (no API key set)" : ""}</option>
      </select>
    </label>
  );

  return (
    <div className="app">
      <aside className="side">
        <h1 className="brand">AI Purchasing Agent</h1>
        <p className="sub">Reviews, executes and validates purchasing decisions{health ? ` · sim date ${health.simDate}` : ""}</p>
        {grouped.map(([g, list]) => (
          <div className="group" key={g}>
            <h3>{GROUP_LABEL[g] ?? g}</h3>
            {list.map((s) => (
              <button key={s.id} className={`sc ${s.id === selected ? "on" : ""}`} onClick={() => { setSelected(s.id); setTab("run"); setRun(null); }}>
                <div className="t">{s.title}</div><div className="id">{s.id}</div>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="main">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "run"} className={`tab ${tab === "run" ? "on" : ""}`} onClick={() => setTab("run")}>Run a scenario</button>
          <button role="tab" aria-selected={tab === "eval"} className={`tab ${tab === "eval" ? "on" : ""}`} onClick={() => setTab("eval")}>Evaluation suite</button>
        </div>
        {error && <div className="card err" role="alert">{error}</div>}

        {tab === "run" && current && (
          <>
            <div className="head">
              <h1>{current.title}</h1>
              <p>{current.description}</p>
              <div>{triggerChips(current.trigger, current.faults).map((c) => <span key={c} className="chip">{c}</span>)}</div>
            </div>
            <div className="bar">
              <button className="btn" onClick={runScenario} disabled={busy}>{busy ? <><span className="spin" />Agent working…</> : "Run agent"}</button>
              {providerSelect}
            </div>
            {!run ? (
              <div className="empty">Run the agent to see its decision, every tool call, the read-back verification of each write, and an independent audit of the final state.</div>
            ) : (
              <>
                <DecisionCard run={run} />
                <div className="cols">
                  <Trace events={run.trace} />
                  <StatePanel run={run} onApproval={approve} busy={busy} />
                </div>
              </>
            )}
          </>
        )}

        {tab === "eval" && (
          <>
            <div className="head">
              <h1>Evaluation suite</h1>
              <p>Every scenario is scored on six questions: was the decision correct, did it get the information, did it respect constraints, did it take the right action, did it validate the result, and what happened when an action failed.</p>
            </div>
            <div className="bar">
              <button className="btn" onClick={runEvals} disabled={busy}>{busy ? <><span className="spin" />Running…</> : `Run all ${scenarios.length} scenarios`}</button>
              {providerSelect}
            </div>
            {evalReport ? <EvalMatrix report={evalReport} /> : <div className="empty">Run the suite to see the scorecard.</div>}
          </>
        )}
      </main>
    </div>
  );
}
