import { api } from "./api";
import { HEALTH, nodeName, productName, shortDate, usd } from "./format";
import { useStore } from "./store";
import { AgentAction, Badge, Empty, HealthBadge } from "./ui";

export default function Today({ go }: { go: (p: string) => void }) {
  const { ws, act, update, openDrawer, busy } = useStore();
  if (!ws) return <Empty>Loading your workspace…</Empty>;

  const pending = ws.approvals.filter((a) => a.status === "pending");
  const escalations = ws.escalations.filter((e) => e.status === "open");
  const decisions = pending.length + escalations.length;
  const agentItems = ws.feed.filter((f) => f.kind === "agent").slice(0, 6);
  const atRisk = ws.rows.filter((r) => r.health === "critical" || r.health === "needs_order");
  const counts = { healthy: 0, needs_order: 0, critical: 0, excess: 0 } as Record<string, number>;
  ws.rows.forEach((r) => counts[r.health]++);
  const arriving = ws.orders.filter((o) => o.status === "open").sort((a, b) => a.eta.localeCompare(b.eta)).slice(0, 5);
  const paused = ws.settings.mode === "paused";

  const sentence = paused
    ? "Automation is paused. Nothing will be ordered until you resume it."
    : decisions
      ? `${decisions} thing${decisions > 1 ? "s need" : " needs"} your decision. Everything else is handled.`
      : atRisk.length
        ? "The agent is keeping an eye on items that are running low."
        : "All clear. Stock is healthy and the agent is watching.";

  return (
    <div>
      <div className="phead">
        <div>
          <h1>Today <span className="muted">· {shortDate(ws.simDate)}</span></h1>
          <p className="lede">{sentence}</p>
        </div>
      </div>

      <section className="card" aria-labelledby="needs">
        <h2 id="needs">Needs your decision {decisions > 0 && <Badge tone="b-warn">{decisions}</Badge>}</h2>
        {decisions === 0 && <div className="muted">Nothing is waiting for you.</div>}
        {pending.map((a) => {
          const o = ws.orders.find((x) => x.id === a.poId);
          return (
            <div key={a.id} className="decide">
              <div>
                <div className="dtitle">{o ? `Approve ${o.qty} × ${o.name}?` : `Approve ${a.poId}?`}</div>
                <div className="small muted">
                  {o && `${o.supplierName} · ${nodeName(ws, o.node)} · ${usd(a.valueUsd)} · arrives ${shortDate(o.eta)}. `}
                  {ws.settings.mode === "approve_all" ? "You asked to approve every order." : a.reason}
                </div>
                {o && <button className="link" onClick={() => openDrawer({ type: "order", id: o.id })}>See details</button>}
              </div>
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => act(() => api.wsApproval(a.id, "approved").then(update))}>Approve</button>
                <button className="btn ghost" disabled={busy} onClick={() => act(() => api.wsApproval(a.id, "rejected").then(update))}>Reject</button>
              </div>
            </div>
          );
        })}
        {escalations.map((e) => (
          <div key={e.id} className="decide">
            <div>
              <div className="dtitle">
                <Badge tone={e.severity === "high" ? "b-bad" : "b-warn"}>{e.severity === "high" ? "Urgent" : "Attention"}</Badge>{" "}
                {productName(ws, e.sku)} · {nodeName(ws, e.node)}
              </div>
              <div className="small">{e.summary}</div>
              <div className="small muted">Suggested next step: {e.recommendedNextStep}</div>
              <button className="link" onClick={() => openDrawer({ type: "item", sku: e.sku, node: e.node })}>Open item</button>
            </div>
            <div className="row">
              <button className="btn ghost" disabled={busy} onClick={() => act(() => api.wsResolve(e.id).then(update))}>Mark as handled</button>
            </div>
          </div>
        ))}
      </section>

      <div className="cols2">
        <section className="card" aria-labelledby="handled">
          <h2 id="handled">Handled for you</h2>
          {agentItems.length === 0 && <div className="muted">The agent hasn't needed to act yet.</div>}
          {agentItems.map((f) => f.kind === "agent" && <AgentAction key={f.seq} item={f} />)}
          <button className="link" onClick={() => go("automation")}>See all activity</button>
        </section>

        <div>
          <section className="card" aria-labelledby="health">
            <h2 id="health">Stock health</h2>
            <div className="tiles">
              {(Object.keys(HEALTH) as Array<keyof typeof HEALTH>).map((k) => (
                <button key={k} className={`tile ${HEALTH[k].tone}`} onClick={() => go("inventory")}>
                  <span className="tnum">{counts[k]}</span><span className="small">{HEALTH[k].label}</span>
                </button>
              ))}
            </div>
            {atRisk.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {atRisk.map((r) => (
                  <button key={r.sku + r.node} className="lrow" onClick={() => openDrawer({ type: "item", sku: r.sku, node: r.node })}>
                    <span>{r.name} <span className="muted small">· {nodeName(ws, r.node)}</span></span>
                    <span className="small">{r.daysOfCover} days left <HealthBadge h={r.health} /></span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="arr">
            <h2 id="arr">Arriving soon</h2>
            {arriving.length === 0 && <div className="muted">No open orders.</div>}
            {arriving.map((o) => (
              <button key={o.id} className="lrow" onClick={() => openDrawer({ type: "order", id: o.id })}>
                <span>{o.qty} × {o.name}</span><span className="small muted">{shortDate(o.eta)} · {o.supplierName}</span>
              </button>
            ))}
          </section>

          <section className="card" aria-labelledby="bud">
            <h2 id="bud">Budget left</h2>
            <div className="kv">{ws.budgets.map((b) => <><span key={b.category + "l"} style={{ textTransform: "capitalize" }}>{b.category}</span><b key={b.category}>{usd(b.remainingUsd)}</b></>)}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
