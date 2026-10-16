import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { Trace } from "./components";
import { agentHeadline, HEALTH, nodeName, shortDate, TRIGGER_LABEL } from "./format";
import { useStore } from "./store";
import type { AgentFeedItem, PairRow, RunResult } from "./types";

export const Badge = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;
export const HealthBadge = ({ h }: { h: PairRow["health"] }) => <Badge tone={HEALTH[h].tone}>{HEALTH[h].label}</Badge>;

export function PositionBar({ r }: { r: PairRow }) {
  const max = Math.max(r.target * 1.6, r.position * 1.05, 1);
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const hand = Math.min(r.onHand, r.position);
  return (
    <div className="pbar" role="img" aria-label={`On hand ${r.onHand}, inbound ${r.incoming}, reorder point ${r.reorderPoint}, target ${r.target}`}>
      <div className="seg hand" style={{ width: pct(hand) }} />
      <div className="seg inbound" style={{ left: pct(hand), width: `calc(${pct(r.position)} - ${pct(hand)})` }} />
      <div className="mark rop" style={{ left: pct(r.reorderPoint) }} />
      <div className="mark tgt" style={{ left: pct(r.target) }} />
    </div>
  );
}

export function Spark({ values, baseline }: { values: number[]; baseline: number }) {
  const w = 480, h = 64, pad = 4;
  const max = Math.max(...values, baseline * 1.2, 1);
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(values.length - 1, 1);
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Daily sales for the last ${values.length} days; normal is ${baseline} a day`}>
      <line x1={pad} x2={w - pad} y1={y(baseline)} y2={y(baseline)} stroke="var(--muted)" strokeDasharray="3 3" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {values.length > 0 && <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3" fill="var(--accent)" />}
    </svg>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h2>{title}</h2><button ref={closeRef} className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="tdot" aria-hidden />
          <div><div className="small muted">Agent</div>{t.text}</div>
          <button className="x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** One thing the agent did, in plain language, with an on-demand explanation. Technical trace is opt-in. */
export function AgentAction({ item, compact = false }: { item: AgentFeedItem; compact?: boolean }) {
  const { ws, openDrawer } = useStore();
  const [why, setWhy] = useState(false);
  const [tech, setTech] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState("");
  if (!ws) return null;
  const h = agentHeadline(ws, item);
  const toggleWhy = () => {
    setWhy(!why);
    if (!run) api.wsRun(item.runId).then(setRun).catch((e) => setErr(String(e.message)));
  };
  const icon = { done: "✓", waiting: "◔", attention: "!", info: "i" }[h.tone];
  return (
    <div className={`action ${h.tone}`}>
      <span className={`aicon ${h.tone}`} aria-hidden>{icon}</span>
      <div className="abody">
        {h.lines.map((l, i) => <div key={i} className="aline">{l}</div>)}
        <div className="small muted">
          {shortDate(item.simDate)} · {TRIGGER_LABEL[item.issueType] ?? item.issueType} ·{" "}
          {!compact && <button className="link" onClick={() => openDrawer({ type: "item", sku: item.sku, node: item.node })}>{nodeName(ws, item.node)}</button>}
          {compact && nodeName(ws, item.node)}
        </div>
        <div className="arow">
          <button className="link" onClick={toggleWhy} aria-expanded={why}>{why ? "Hide reasoning" : "Why?"}</button>
          {why && <button className="link" onClick={() => setTech(!tech)} aria-expanded={tech}>{tech ? "Hide technical trace" : "Technical trace"}</button>}
        </div>
        {why && (
          <div className="why">
            {err && <div className="err">{err}</div>}
            {!run && !err && <span className="muted">Loading…</span>}
            {run && (
              <>
                <ul className="plain">{run.decision.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
                {run.decision.risks.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Watch-outs:</b> {run.decision.risks.join(" ")}</div>}
                <div className="small muted" style={{ marginTop: 6 }}>
                  {run.audit.poValidations.length > 0
                    ? `Checked after ordering: ${run.audit.poValidations.every((v) => v.ok) ? "every order passed budget, storage, minimum-order and approval checks." : "some checks failed, see the technical trace."}`
                    : "No order was placed."}
                </div>
                {tech && <div style={{ marginTop: 8 }}><Trace events={run.trace} /></div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
