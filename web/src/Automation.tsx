import { useState } from "react";
import { api } from "./api";
import { usd } from "./format";
import { useStore } from "./store";
import type { Mode } from "./types";
import { AgentAction, Empty } from "./ui";

const MODES: Array<{ id: Mode; title: string; body: string }> = [
  { id: "autonomous", title: "Autonomous", body: "The agent places orders up to your approval limit and asks you about anything bigger." },
  { id: "approve_all", title: "Ask me first", body: "The agent prepares every order, but nothing is sent to a supplier until you approve it." },
  { id: "paused", title: "Paused", body: "The agent stops watching and ordering. Resume any time; it will catch up straight away." },
];

export default function Automation() {
  const { ws, act, update, busy } = useStore();
  const [limit, setLimit] = useState<string | null>(null);
  if (!ws) return <Empty>Loading…</Empty>;
  const shown = limit ?? String(ws.settings.autoApproveLimitUsd);
  const agent = ws.feed.filter((f) => f.kind === "agent");
  const dirty = limit !== null && Number(limit) !== ws.settings.autoApproveLimitUsd;
  return (
    <div>
      <div className="phead"><div><h1>Automation</h1><p className="lede">Decide how much the agent does on its own.</p></div></div>
      <div className="modes" role="radiogroup" aria-label="Automation mode">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={ws.settings.mode === m.id} className={`mode ${ws.settings.mode === m.id ? "on" : ""}`} disabled={busy}
            onClick={() => act(() => api.settings({ mode: m.id }).then(update))}>
            <b>{m.title}</b><span className="small muted">{m.body}</span>
          </button>
        ))}
      </div>
      <section className="card">
        <h2>Approval limit</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {ws.settings.mode === "approve_all" ? "Not used right now: every order needs your approval." : "Orders above this value wait for your approval. Smaller ones are placed automatically."}
        </p>
        <div className="bar" style={{ margin: 0 }}>
          <label className="small" htmlFor="lim">Limit (USD)</label>
          <input id="lim" className="input" type="number" min={0} step={500} value={shown} onChange={(e) => setLimit(e.target.value)} />
          <button className="btn" disabled={!dirty || busy || Number(shown) < 0 || shown === ""} onClick={() => act(() => api.settings({ autoApproveLimitUsd: Number(shown) }).then((w) => { update(w); setLimit(null); }))}>Save</button>
          <span className="small muted">Currently {usd(ws.settings.autoApproveLimitUsd)}</span>
        </div>
      </section>
      <section className="card">
        <h2>Activity log</h2>
        {agent.length === 0 && <div className="muted">No activity yet.</div>}
        {agent.map((f) => f.kind === "agent" && <AgentAction key={f.seq} item={f} />)}
      </section>
      <section className="card">
        <h2>Other events</h2>
        {ws.feed.filter((f) => f.kind !== "agent").slice(0, 25).map((f) => <div key={f.seq} className="small" style={{ padding: "3px 0" }}><span className="muted">{f.simDate} · </span>{f.text}</div>)}
      </section>
    </div>
  );
}
