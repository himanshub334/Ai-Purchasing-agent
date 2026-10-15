import type { EvalReport, Finding, Po, RunResult, TraceEvent } from "./types";

const actionTone = (a: string) => ({ accept: "b-ok", modify: "b-info", reject: "b-warn", no_action: "b-info", investigate: "b-warn", escalate: "b-bad" })[a] ?? "b-info";
const statusTone = (s: string) => ({ completed: "b-ok", needs_human: "b-warn", failed: "b-bad" })[s] ?? "b-info";
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function DecisionCard({ run }: { run: RunResult }) {
  const d = run.decision;
  return (
    <div className="card decision">
      <h2>Decision</h2>
      <span className={`badge ${actionTone(d.action)}`}>{d.action.replace("_", " ")}</span>{" "}
      <span className={`badge ${statusTone(run.status)}`}>{run.status.replace("_", " ")}</span>{" "}
      <span className="muted" style={{ fontSize: 12 }}>{run.provider} agent · {run.durationMs} ms</span>
      <div className="sum">{d.summary}</div>
      <Section title="Important factors" items={d.rationale} />
      <Section title="Actions taken" items={d.actionsTaken} />
      <Section title="Residual risks" items={d.risks} />
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{title}</div>
      <ul className="plain">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <span className="muted">no findings</span>;
  return <>{findings.map((f, i) => <div key={i} className={f.severity === "violation" ? "err" : "muted"}>{f.severity === "violation" ? "✗" : "!"} {f.code}: {f.message}</div>)}</>;
}

export function Trace({ events }: { events: TraceEvent[] }) {
  return (
    <div className="card">
      <h2>Agent trace · {events.filter((e) => e.kind === "tool").length} tool calls</h2>
      {events.map((e, i) => {
        if (e.kind === "tool")
          return (
            <div className="ev" key={i}>
              <span className={`dot ${!e.ok ? "fail" : e.write ? "write" : ""}`}>{e.step}</span>
              <div>
                <div className="name">{e.tool} {e.write && <span className="badge b-info" style={{ marginLeft: 6 }}>write</span>} {!e.ok && <span className="badge b-bad">error</span>}</div>
                <div className="meta">{summarizeInput(e.input)} · {e.ms} ms</div>
                <details><summary>{e.ok ? "result" : "error"}</summary><pre>{JSON.stringify(e.output, null, 2)}</pre></details>
              </div>
            </div>
          );
        if (e.kind === "verification")
          return (
            <div className="ev" key={i}>
              <span className={`dot ${e.ok ? "ver" : "fail"}`}>{e.ok ? "✓" : "✗"}</span>
              <div>
                <div className="name">verify {e.poId} <span className={`badge ${e.ok ? "b-ok" : "b-bad"}`}>{e.ok ? "acceptable" : "mismatch"}</span></div>
                <div className="meta"><Findings findings={e.findings} /></div>
              </div>
            </div>
          );
        if (e.kind === "recovery")
          return (
            <div className="ev" key={i}>
              <span className="dot rec">↻</span>
              <div><div className="name">recovery</div><div className="meta">{e.text}</div></div>
            </div>
          );
        return (
          <div className="ev" key={i}>
            <span className="dot th">…</span>
            <div className="meta">{e.text}</div>
          </div>
        );
      })}
    </div>
  );
}

function summarizeInput(i: unknown): string {
  if (!i || typeof i !== "object") return "";
  return Object.entries(i as Record<string, unknown>).filter(([k]) => k !== "reason").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

export function StatePanel({ run, onApproval, busy }: { run: RunResult; onApproval: (approvalId: string, d: "approved" | "rejected") => void; busy: boolean }) {
  const a = run.audit;
  const pos = run.endState.purchaseOrders.filter((p: Po) => p.createdBy === "agent");
  return (
    <div>
      <div className="card">
        <h2>Independent audit</h2>
        <div className="kv">
          <span>Coverage after actions</span><span className={`badge ${a.coverage.covered ? "b-ok" : "b-warn"}`}>{a.coverage.covered ? "covered" : "gap"}</span>
          <span>Inventory position / target</span><b>{a.coverage.position} / {a.coverage.target}</b>
          <span>Remaining shortfall</span><b>{a.coverage.shortfall}</b>
          <span>Projected stock-out day</span><b>{a.coverage.stockoutDay ?? "none"}</b>
          <span>Writes that failed verification</span><b>{a.unverifiedWrites}</b>
          <span>Write errors handled</span><b>{run.writeErrors.length}</b>
        </div>
        {a.poValidations.map((v) => (
          <div key={v.poId} style={{ marginTop: 8, fontSize: 12 }}>
            <b>{v.poId}</b> <span className={`badge ${v.ok ? "b-ok" : "b-bad"}`}>{v.ok ? "valid" : "invalid"}</span>
            <div className="muted"><Findings findings={v.findings} /></div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Purchase orders created</h2>
        {pos.length === 0 ? <span className="muted">None: the agent did not place an order.</span> : (
          <table>
            <thead><tr><th>PO</th><th>Supplier</th><th>Qty</th><th>Value</th><th>Status</th></tr></thead>
            <tbody>{pos.map((p) => (
              <tr key={p.id}><td className="muted">{p.id}</td><td>{p.supplierId.replace("SUP-", "")}</td><td>{p.qty}</td><td>{usd(p.qty * p.unitCost)}</td>
                <td><span className={`badge ${p.status === "open" ? "b-ok" : p.status === "pending_approval" ? "b-warn" : "b-bad"}`}>{p.status.replace("_", " ")}</span></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {run.endState.approvals.length > 0 && (
        <div className="card">
          <h2>Approval queue (human in the loop)</h2>
          {run.endState.approvals.map((ap) => (
            <div key={ap.id} style={{ marginBottom: 8 }}>
              <div><b>{ap.poId}</b> · {usd(ap.valueUsd)} <span className={`badge ${ap.status === "pending" ? "b-warn" : ap.status === "approved" ? "b-ok" : "b-bad"}`}>{ap.status}</span></div>
              <div className="muted" style={{ fontSize: 12 }}>{ap.reason}</div>
              {ap.status === "pending" && (
                <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                  <button className="btn sm" disabled={busy} onClick={() => onApproval(ap.id, "approved")}>Approve</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => onApproval(ap.id, "rejected")}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {run.endState.escalations.length > 0 && (
        <div className="card">
          <h2>Escalations to buyer</h2>
          {run.endState.escalations.map((e) => (
            <div key={e.id} style={{ marginBottom: 8 }}>
              <span className={`badge ${e.severity === "high" ? "b-bad" : e.severity === "medium" ? "b-warn" : "b-info"}`}>{e.severity}</span> {e.summary}
              <div className="muted" style={{ fontSize: 12 }}>Next step: {e.recommendedNextStep}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DIMS = ["decision", "information", "constraints", "action", "validation", "recovery"];
const DIM_LABEL: Record<string, string> = {
  decision: "Decision correct?", information: "Got the information?", constraints: "Respected constraints?",
  action: "Right action?", validation: "Validated result?", recovery: "Handled failure?",
};

export function EvalMatrix({ report }: { report: EvalReport }) {
  return (
    <div className="card">
      <h2>{report.passed}/{report.total} scenarios pass · planner: {report.planner}</h2>
      <div style={{ overflowX: "auto" }}>
        <table className="matrix">
          <thead><tr><th>Scenario</th>{DIMS.map((d) => <th key={d} title={DIM_LABEL[d]}>{d.slice(0, 5)}</th>)}<th>Decision</th></tr></thead>
          <tbody>
            {report.reports.map((r) => (
              <tr key={r.id}>
                <td><div style={{ fontWeight: 500 }}>{r.id}</div><div className="muted" style={{ fontSize: 12 }}>{r.title}</div></td>
                {DIMS.map((d) => (
                  <td key={d}><span className={`cell ${r.dimensions[d].pass ? "b-ok" : "b-bad"}`} title={`${DIM_LABEL[d]} ${r.dimensions[d].detail}`}>{r.dimensions[d].pass ? "✓" : "✗"}</span></td>
                ))}
                <td><span className={`badge ${actionTone(r.decision)}`}>{r.decision.replace("_", " ")}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Hover a cell for the evidence. Columns: {DIMS.map((d) => DIM_LABEL[d]).join(" · ")}</p>
    </div>
  );
}
