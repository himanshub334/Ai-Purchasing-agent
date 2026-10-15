import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { DecisionCard, Trace } from "./components";
import type { FeedItem, PairRow, RunResult, Workspace } from "./types";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const HEALTH: Record<PairRow["health"], { label: string; tone: string }> = {
  healthy: { label: "Healthy", tone: "b-ok" },
  needs_order: { label: "Needs order", tone: "b-warn" },
  critical: { label: "Stock-out risk", tone: "b-bad" },
  excess: { label: "Excess", tone: "b-info" },
};
const DECISION_TONE: Record<string, string> = { accept: "b-ok", modify: "b-info", reject: "b-warn", no_action: "b-info", investigate: "b-warn", escalate: "b-bad" };
const ISSUE_LABEL: Record<string, string> = { purchase_needed: "reorder point", supplier_shortfall: "supplier short-ship", demand_change: "demand change", review_recommendation: "review" };
const pairId = (r: { sku: string; node: string }) => `${r.sku}@${r.node}`;
const short = (n: string) => n.replace("FC-BLR-01", "Main FC").replace("DS-BLR-07", "Dark store 7");

function PositionBar({ r }: { r: PairRow }) {
  const max = Math.max(r.target * 1.6, r.position * 1.05, 1);
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const hand = Math.min(r.onHand, r.position);
  return (
    <div className="pbar" title={`on hand ${r.onHand} · inbound ${r.incoming}${r.pendingApprovalQty ? ` · awaiting approval ${r.pendingApprovalQty}` : ""} · reorder point ${r.reorderPoint} · target ${r.target}`}>
      <div className="seg hand" style={{ width: pct(hand) }} />
      <div className="seg inbound" style={{ left: pct(hand), width: `calc(${pct(r.position)} - ${pct(hand)})` }} />
      <div className="mark rop" style={{ left: pct(r.reorderPoint) }} />
      <div className="mark tgt" style={{ left: pct(r.target) }} />
    </div>
  );
}

export default function Live() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [provider, setProvider] = useState("policy");
  const [speed, setSpeed] = useState(3000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<RunResult | null>(null);
  const [anthropicOk, setAnthropicOk] = useState(false);
  const acting = useRef(false);

  useEffect(() => { api.health().then((h) => setAnthropicOk(h.anthropicConfigured)).catch(() => undefined); }, []);

  // Poll so autopilot (server-side) is visible live. Skip while an action of ours is in flight.
  useEffect(() => {
    let alive = true;
    const tick = () => { if (!acting.current) api.workspace().then((w) => alive && setWs(w)).catch((e) => alive && setError(String(e.message))); };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const act = useCallback(async (fn: () => Promise<Workspace | void>) => {
    acting.current = true; setBusy(true); setError("");
    try { const w = await fn(); if (w) setWs(w); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { acting.current = false; setBusy(false); }
  }, []);

  const openRun = (id: string) => api.wsRun(id).then(setRun).catch((e) => setError(String(e.message)));

  const attention = ws?.rows.filter((r) => r.health === "critical" || r.health === "needs_order").length ?? 0;
  const openEsc = ws?.escalations.filter((e) => e.status === "open") ?? [];
  const agentRuns = ws?.feed.filter((f) => f.kind === "agent").length ?? 0;

  if (!ws) return <main className="main">{error ? <div className="card err">{error}</div> : <div className="empty"><span className="spin" />Loading workspace…</div>}</main>;
  const auto = ws.autopilot.enabled;

  return (
    <main className="main wide">
      {error && <div className="card err" role="alert">{error}</div>}

      <section className="controls card">
        <div className="date"><div className="muted small">Simulated date</div><div className="bigdate">{ws.simDate}</div></div>
        <div className="grp">
          <button className="btn" disabled={busy || ws.busy} onClick={() => act(() => api.advance(1, provider))}>{busy ? <><span className="spin" />Working…</> : "Next day"}</button>
          <button className="btn ghost" disabled={busy || ws.busy} onClick={() => act(() => api.advance(7, provider))}>+7 days</button>
          <button className="btn ghost" disabled={busy || ws.busy} onClick={() => act(() => api.scan(provider))}>Agent scan now</button>
        </div>
        <div className="grp">
          <label className="switch">
            <input type="checkbox" checked={auto} onChange={(e) => act(() => api.autopilot(e.target.checked, speed, provider))} />
            <span className="track" /><span>Autopilot {auto ? <b className="live">● running</b> : "off"}</span>
          </label>
          <label className="muted small">one day every{" "}
            <select value={speed} onChange={(e) => { const v = Number(e.target.value); setSpeed(v); if (auto) act(() => api.autopilot(true, v, provider)); }}>
              <option value={1500}>1.5 s</option><option value={3000}>3 s</option><option value={6000}>6 s</option>
            </select>
          </label>
        </div>
        <div className="grp">
          <label className="muted small">Agent{" "}
            <select value={provider} onChange={(e) => { setProvider(e.target.value); if (auto) act(() => api.autopilot(true, speed, e.target.value)); }}>
              <option value="policy">Policy agent (offline)</option>
              <option value="anthropic" disabled={!anthropicOk}>Claude{anthropicOk ? "" : " (no API key)"}</option>
            </select>
          </label>
          <button className="btn ghost sm" disabled={busy} onClick={() => { setRun(null); act(() => api.reset()); }}>Reset</button>
        </div>
      </section>

      <section className="kpis">
        <div className="kpi"><div className="muted small">Need attention</div><div className={`num ${attention ? "warn" : ""}`}>{attention}</div></div>
        <div className="kpi"><div className="muted small">Awaiting your approval</div><div className={`num ${ws.approvals.length ? "warn" : ""}`}>{ws.approvals.length}</div></div>
        <div className="kpi"><div className="muted small">Open escalations</div><div className={`num ${openEsc.length ? "bad" : ""}`}>{openEsc.length}</div></div>
        <div className="kpi"><div className="muted small">Agent runs</div><div className="num">{agentRuns}</div></div>
        <div className="kpi wideKpi"><div className="muted small">Budget left</div><div className="budgets">{ws.budgets.map((b) => <span key={b.category} className="chip">{b.category} {usd(b.remainingUsd)}</span>)}</div></div>
      </section>

      <section className="card">
        <h2>Inventory position · the agent watches these</h2>
        <div style={{ overflowX: "auto" }}>
          <table className="board">
            <thead><tr><th>Product</th><th>On hand</th><th>Demand / day</th><th>Inbound</th><th style={{ minWidth: 190 }}>Position <span className="legend"><i className="l hand" />stock <i className="l inbound" />inbound <i className="l rop" />reorder <i className="l tgt" />target</span></th><th>Cover</th><th>Status</th></tr></thead>
            <tbody>
              {ws.rows.map((r) => (
                <tr key={pairId(r)}>
                  <td><div style={{ fontWeight: 500 }}>{r.name}</div><div className="muted small">{r.sku} · {short(r.node)}</div></td>
                  <td className="mono">{r.onHand}</td>
                  <td className="mono">{r.dailyDemand}{r.demandNote !== "normal" && <div className={`small ${r.demandNote === "sustained increase" ? "warn" : "muted"}`}>{r.demandNote}</div>}</td>
                  <td className="mono">{r.incoming}{r.pendingApprovalQty > 0 && <div className="small warn">+{r.pendingApprovalQty} pending</div>}</td>
                  <td><PositionBar r={r} /><div className="muted small mono">{r.position} / target {r.target}</div></td>
                  <td className="mono">{r.daysOfCover}d</td>
                  <td><span className={`badge ${HEALTH[r.health].tone}`}>{HEALTH[r.health].label}</span>{r.blockedByEscalation && <div className="small warn">waiting for you</div>}{r.surge !== 1 && <div className="small muted">sales ×{r.surge}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="cols2">
        <div>
          <section className="card">
            <h2>Activity · what the agent noticed and did</h2>
            <Feed items={ws.feed} onOpen={openRun} activeRun={run?.runId} />
          </section>
        </div>
        <div>
          <HumanPanel ws={ws} busy={busy} act={act} />
          <EventPanel ws={ws} busy={busy} act={act} />
        </div>
      </div>

      {run && (
        <section>
          <div className="runhead"><h2 className="sech">Agent run detail</h2><button className="btn ghost sm" onClick={() => setRun(null)}>Close</button></div>
          <DecisionCard run={run} />
          <Trace events={run.trace} />
        </section>
      )}
    </main>
  );
}

function Feed({ items, onOpen, activeRun }: { items: FeedItem[]; onOpen: (id: string) => void; activeRun?: string }) {
  if (!items.length) return <div className="muted">Nothing yet.</div>;
  return (
    <div className="feed">
      {items.map((f) => f.kind === "agent" ? (
        <button key={f.seq} className={`fi agent ${activeRun === f.runId ? "on" : ""}`} onClick={() => onOpen(f.runId)}>
          <div className="fh"><span className="muted small mono">{f.simDate}</span><span className={`badge ${DECISION_TONE[f.decision] ?? "b-info"}`}>{f.decision.replace("_", " ")}</span><span className="small muted">{ISSUE_LABEL[f.issueType] ?? f.issueType} · {f.sku} · {short(f.node)}</span>{f.needsHuman && <span className="badge b-warn">needs you</span>}</div>
          <div>{f.text}</div>
          <div className="small muted">Click for the full reasoning and tool trace</div>
        </button>
      ) : (
        <div key={f.seq} className={`fi ${f.kind}`}>
          <span className="muted small mono">{f.simDate}</span> <span className="tag">{f.kind === "human" ? "you" : "world"}</span> {f.text}
        </div>
      ))}
    </div>
  );
}

function HumanPanel({ ws, busy, act }: { ws: Workspace; busy: boolean; act: (fn: () => Promise<Workspace | void>) => void }) {
  const open = ws.escalations.filter((e) => e.status === "open");
  return (
    <section className="card">
      <h2>Needs a human</h2>
      {ws.approvals.length === 0 && open.length === 0 && <div className="muted">Nothing is waiting for you.</div>}
      {ws.approvals.map((a) => {
        const po = ws.purchaseOrders.find((p) => p.id === a.poId);
        return (
          <div key={a.id} className="item">
            <div><b>Approve {a.poId}</b> · {usd(a.valueUsd)} {po && <span className="muted">({po.qty} × {po.sku})</span>}</div>
            <div className="muted small">{a.reason}</div>
            <div className="row"><button className="btn sm" disabled={busy} onClick={() => act(() => api.wsApproval(a.id, "approved"))}>Approve</button><button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.wsApproval(a.id, "rejected"))}>Reject</button></div>
          </div>
        );
      })}
      {open.map((e) => (
        <div key={e.id} className="item">
          <div><span className={`badge ${e.severity === "high" ? "b-bad" : e.severity === "medium" ? "b-warn" : "b-info"}`}>{e.severity}</span> <b>{e.sku}</b> <span className="muted small">{short(e.node)}</span></div>
          <div>{e.summary}</div>
          <div className="muted small">Next step: {e.recommendedNextStep}</div>
          <div className="row"><button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.wsResolve(e.id))}>Mark resolved</button></div>
        </div>
      ))}
    </section>
  );
}

function EventPanel({ ws, busy, act }: { ws: Workspace; busy: boolean; act: (fn: () => Promise<Workspace | void>) => void }) {
  const pairs = useMemo(() => ws.rows.map(pairId), [ws.rows]);
  const [pair, setPair] = useState(pairs[0] ?? "");
  const openPos = ws.purchaseOrders.filter((p) => p.status === "open");
  const [poId, setPoId] = useState("");
  const [cat, setCat] = useState("dairy");
  const [mult, setMult] = useState(1.8);
  const selPo = openPos.find((p) => p.id === poId) ?? openPos[0];
  const [sku, node] = pair.split("@");
  return (
    <section className="card">
      <h2>Make something happen</h2>
      <div className="muted small" style={{ marginBottom: 8 }}>Change the world and watch the agent react{ws.autopilot.enabled ? " immediately (autopilot is on)" : " on the next scan or day"}.</div>
      <div className="evrow">
        <select value={pair} onChange={(e) => setPair(e.target.value)} aria-label="Product and node">{ws.rows.map((r) => <option key={pairId(r)} value={pairId(r)}>{r.sku} · {short(r.node)}</option>)}</select>
        <select value={mult} onChange={(e) => setMult(Number(e.target.value))} aria-label="Surge size"><option value={1.5}>×1.5</option><option value={1.8}>×1.8</option><option value={2.5}>×2.5</option><option value={4}>×4</option></select>
        <button className="btn sm" disabled={busy} onClick={() => act(() => api.event({ type: "sales_surge", sku, node, multiplier: mult }))}>Sales surge</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.event({ type: "sales_normal", sku, node }))}>Normal</button>
      </div>
      <div className="evrow">
        <select value={selPo?.id ?? ""} onChange={(e) => setPoId(e.target.value)} aria-label="Purchase order" disabled={!openPos.length}>{openPos.length ? openPos.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.qty} × {p.sku}</option>) : <option>no open POs</option>}</select>
        <button className="btn sm" disabled={busy || !selPo} onClick={() => selPo && act(() => api.event({ type: "supplier_short", poId: selPo.id, confirmedQty: Math.floor(selPo.qty / 2) }))}>Supplier ships only half</button>
      </div>
      <div className="evrow">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Budget category">{ws.budgets.map((b) => <option key={b.category}>{b.category}</option>)}</select>
        <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.event({ type: "add_budget", category: cat, amountUsd: 2000 }))}>Release +$2,000</button>
      </div>
      <details style={{ marginTop: 8 }}><summary>Open purchase orders ({ws.purchaseOrders.length})</summary>
        <table style={{ marginTop: 6 }}><thead><tr><th>PO</th><th>SKU</th><th>Qty</th><th>ETA</th><th>By</th></tr></thead>
          <tbody>{ws.purchaseOrders.map((p) => <tr key={p.id}><td className="muted">{p.id}</td><td>{p.sku}</td><td>{p.confirmedQty < p.qty ? `${p.confirmedQty}/${p.qty}` : p.qty}</td><td className="mono">{p.eta.slice(5)}</td><td>{p.status === "pending_approval" ? <span className="badge b-warn">pending</span> : p.createdBy}</td></tr>)}</tbody></table>
      </details>
    </section>
  );
}
