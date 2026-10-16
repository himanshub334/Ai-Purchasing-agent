import { useEffect, useState } from "react";
import { api } from "./api";
import { nodeName, productName, SOURCE, shortDate, STATUS, usd, usd2 } from "./format";
import { useStore } from "./store";
import type { Finding, ItemDetail } from "./types";
import { AgentAction, Badge, Drawer, HealthBadge, PositionBar, Spark } from "./ui";

export function DrawerHost() {
  const { drawer, openDrawer, ws } = useStore();
  if (!drawer || !ws) return null;
  const close = () => openDrawer(null);
  if (drawer.type === "item") return <Drawer title={`${productName(ws, drawer.sku)} · ${nodeName(ws, drawer.node)}`} onClose={close}><ItemView sku={drawer.sku} node={drawer.node} /></Drawer>;
  if (drawer.type === "order") return <Drawer title={`Order ${drawer.id}`} onClose={close}><OrderView id={drawer.id} /></Drawer>;
  return <Drawer title="New order" onClose={close}><OrderForm sku={drawer.sku} node={drawer.node} /></Drawer>;
}

function ItemView({ sku, node }: { sku: string; node: string }) {
  const { ws, openDrawer } = useStore();
  const [d, setD] = useState<ItemDetail | null>(null);
  const [err, setErr] = useState("");
  const stamp = `${ws?.simDate}-${ws?.orders.length}-${ws?.feed.length}`;
  useEffect(() => { api.item(sku, node).then(setD).catch((e) => setErr(e.message)); }, [sku, node, stamp]);
  if (err) return <div className="err">{err}</div>;
  if (!d || !ws) return <div className="muted">Loading…</div>;
  const r = d.row;
  return (
    <div>
      <div className="runhead" style={{ marginTop: 0 }}><HealthBadge h={r.health} /><span className="small muted">{r.daysOfCover} days of stock left</span></div>
      <div className="stats">
        <div><b>{r.onHand}</b><span className="small muted">on hand</span></div>
        <div><b>{r.incoming + r.pendingApprovalQty}</b><span className="small muted">on order</span></div>
        <div><b>{r.dailyDemand}</b><span className="small muted">sold per day</span></div>
        <div><b>{r.reorderPoint}</b><span className="small muted">reorder at</span></div>
      </div>
      <PositionBar r={r} />
      <h3 className="dh">Sales, last 14 days</h3>
      <Spark values={d.salesLast14Days} baseline={d.baselineDaily} />
      <div className="small muted">Dashed line is normal ({d.baselineDaily}/day). {d.demandNotes.join(" ")}</div>

      {d.suggestion ? (
        <section className="sugg">
          <h3 className="dh">Suggested order</h3>
          <div><b>{d.suggestion.qty} × {d.product.name}</b> from {d.suggestion.supplierName} · {usd(d.suggestion.valueUsd)}</div>
          <div className="small muted">{d.suggestion.reason}</div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => openDrawer({ type: "newOrder", sku, node })}>Review and place order</button>
        </section>
      ) : (
        <section className="sugg"><h3 className="dh">Suggested order</h3><div className="small muted">No order needed right now.</div></section>
      )}

      <h3 className="dh">Suppliers</h3>
      <table>
        <thead><tr><th>Supplier</th><th className="num">Unit</th><th className="num">Lead</th><th className="num">Min</th><th className="num">Max</th></tr></thead>
        <tbody>{d.options.map((o) => (
          <tr key={o.supplierId}><td>{o.supplierName}{!o.active && <span className="bad small"> inactive</span>}{o.arrivesAfterStockout && <span className="warn small"> too slow</span>}</td><td className="num">{usd2(o.unitCost)}</td><td className="num">{o.leadTimeDays} d</td><td className="num">{o.moq}</td><td className="num">{o.maxQtyPerOrder ?? "–"}</td></tr>
        ))}</tbody>
      </table>

      <h3 className="dh">Orders</h3>
      {d.orders.length === 0 && <div className="small muted">None.</div>}
      {d.orders.map((o) => (
        <button key={o.id} className="lrow" onClick={() => openDrawer({ type: "order", id: o.id })}>
          <span>{o.qty} × from {o.supplierName}</span>
          <span className="small"><Badge tone={STATUS[o.status]?.tone ?? "b-info"}>{STATUS[o.status]?.label ?? o.status}</Badge> {shortDate(o.eta)}</span>
        </button>
      ))}

      <h3 className="dh">Agent activity</h3>
      {d.activity.length === 0 && <div className="small muted">The agent hasn't needed to act on this item.</div>}
      {d.activity.map((f) => <AgentAction key={f.seq} item={f} compact />)}
    </div>
  );
}

function OrderView({ id }: { id: string }) {
  const { ws, act, update, busy, openDrawer } = useStore();
  const [reasoning, setReasoning] = useState<string[] | null>(null);
  const o = ws?.orders.find((x) => x.id === id);
  const approval = ws?.approvals.find((a) => a.poId === id && a.status === "pending");
  const runId = o?.runId;
  useEffect(() => { if (runId) api.wsRun(runId).then((r) => setReasoning([r.decision.summary, ...r.decision.rationale])).catch(() => undefined); }, [runId]);
  if (!ws || !o) return <div className="muted">Order not found.</div>;
  return (
    <div>
      <div className="runhead" style={{ marginTop: 0 }}><b>{o.qty} × {o.name}</b><Badge tone={STATUS[o.status]?.tone ?? "b-info"}>{STATUS[o.status]?.label ?? o.status}</Badge></div>
      <div className="kv">
        <span>Supplier</span><b>{o.supplierName}</b>
        <span>Location</span><b>{nodeName(ws, o.node)}</b>
        <span>Unit price</span><b>{usd2(o.unitCost)}</b>
        <span>Total</span><b>{usd2(o.valueUsd)}</b>
        <span>Placed</span><b>{shortDate(o.createdAt)} by {SOURCE[o.createdBy]}</b>
        <span>Arrives</span><b>{shortDate(o.eta)}</b>
        {o.confirmedQty !== o.qty && <><span>Supplier confirmed</span><b className="warn">{o.confirmedQty}</b></>}
      </div>
      {o.note && <p className="small muted">{o.note}</p>}
      {reasoning && (
        <section className="sugg"><h3 className="dh">Why the agent ordered this</h3><ul className="plain">{reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul></section>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        {approval && <>
          <button className="btn" disabled={busy} onClick={() => act(() => api.wsApproval(approval.id, "approved").then(update))}>Approve</button>
          <button className="btn ghost" disabled={busy} onClick={() => act(() => api.wsApproval(approval.id, "rejected").then(update))}>Reject</button>
        </>}
        {o.status === "open" && <button className="btn ghost" disabled={busy} onClick={() => confirm(`Cancel ${o.id}?`) && act(() => api.cancelOrder(o.id).then(update))}>Cancel order</button>}
        <button className="btn ghost" onClick={() => openDrawer({ type: "item", sku: o.sku, node: o.node })}>View item</button>
      </div>
    </div>
  );
}

function OrderForm({ sku: s0, node: n0 }: { sku?: string; node?: string }) {
  const { ws, update, openDrawer } = useStore();
  const first = ws!.rows[0];
  const [sku, setSku] = useState(s0 ?? first.sku);
  const [node, setNode] = useState(n0 ?? first.node);
  const [d, setD] = useState<ItemDetail | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState("");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setD(null); setErr("");
    api.item(sku, node).then((x) => {
      setD(x);
      const pick = x.suggestion?.supplierId ?? x.options.find((o) => o.active)?.supplierId ?? "";
      setSupplierId(pick);
      setQty(String(x.suggestion?.qty ?? x.options.find((o) => o.supplierId === pick)?.moq ?? ""));
    }).catch((e) => setErr(e.message));
  }, [sku, node]);

  const opt = d?.options.find((o) => o.supplierId === supplierId);
  const n = Number(qty);
  const issues: string[] = [];
  if (opt && n > 0) {
    if (n < opt.moq) issues.push(`Minimum order is ${opt.moq}.`);
    if (n % opt.casePack) issues.push(`Must be a multiple of ${opt.casePack} (case pack).`);
    if (opt.maxQtyPerOrder && n > opt.maxQtyPerOrder) issues.push(`Supplier maximum is ${opt.maxQtyPerOrder}.`);
    if (d && n * opt.unitCost > d.budgetRemainingUsd) issues.push(`Over the remaining budget (${usd(d.budgetRemainingUsd)}).`);
    if (d && n * d.product.unitVolumeM3 > d.storageFreeM3) issues.push(`Won't fit: only ${d.storageFreeM3.toFixed(1)} m³ free at this location.`);
  }
  const submit = async () => {
    setSaving(true); setErr(""); setFindings([]);
    try {
      const r = await api.placeOrder({ sku, node, supplierId, qty: n });
      update(r.workspace);
      if (r.findings.length) setFindings(r.findings);
      openDrawer({ type: "order", id: r.po.id });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  const products = ws!.rows;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="form">
      <label>Item
        <select value={`${sku}|${node}`} onChange={(e) => { const [a, b] = e.target.value.split("|"); setSku(a); setNode(b); }}>
          {products.map((r) => <option key={r.sku + r.node} value={`${r.sku}|${r.node}`}>{r.name} · {nodeName(ws!, r.node)}</option>)}
        </select>
      </label>
      {d && <>
        <label>Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {d.options.filter((o) => o.active).map((o) => <option key={o.supplierId} value={o.supplierId}>{o.supplierName} · {usd2(o.unitCost)} · {o.leadTimeDays} days</option>)}
          </select>
        </label>
        <label>Quantity
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        {opt && n > 0 && <div className="small muted">Total {usd2(n * opt.unitCost)} · arrives in {opt.leadTimeDays} days{d.suggestion && d.suggestion.supplierId === supplierId ? ` · suggested ${d.suggestion.qty}` : ""}</div>}
        {issues.map((i) => <div key={i} className="warn small" role="alert">{i}</div>)}
      </>}
      {err && <div className="err" role="alert">{err}</div>}
      {findings.map((f) => <div key={f.code} className="warn small">{f.message}</div>)}
      <button className="btn" type="submit" disabled={saving || !d || !supplierId || !(n > 0)}>{saving ? "Placing…" : "Place order"}</button>
      <div className="small muted">Orders above the approval limit are sent to the approval queue instead of the supplier.</div>
    </form>
  );
}
