import { useState } from "react";
import { nodeName } from "./format";
import { useStore } from "./store";
import { Empty, HealthBadge, PositionBar } from "./ui";

export default function Inventory() {
  const { ws, openDrawer } = useStore();
  const [q, setQ] = useState("");
  const [node, setNode] = useState("all");
  if (!ws) return <Empty>Loading…</Empty>;
  const rows = ws.rows.filter((r) => (node === "all" || r.node === node) && r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="phead">
        <div><h1>Inventory</h1><p className="lede">Stock on hand and on order at each location.</p></div>
        <button className="btn" onClick={() => openDrawer({ type: "newOrder" })}>New order</button>
      </div>
      <div className="bar">
        <input className="input" placeholder="Search products" aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Location" value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="all">All locations</option>
          {ws.nodes.map((n) => <option key={n} value={n}>{nodeName(ws, n)}</option>)}
        </select>
        <span className="legend"><span className="l hand" />on hand<span className="l inbound" />on order<span className="l rop" />reorder point<span className="l tgt" />target</span>
      </div>
      <div className="card">
        <table className="board">
          <thead><tr><th>Product</th><th>Location</th><th className="num">On hand</th><th className="num">On order</th><th>Cover</th><th style={{ width: 160 }}>Stock level</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sku + r.node} className="click" tabIndex={0} onClick={() => openDrawer({ type: "item", sku: r.sku, node: r.node })} onKeyDown={(e) => e.key === "Enter" && openDrawer({ type: "item", sku: r.sku, node: r.node })}>
                <td><b>{r.name}</b></td>
                <td>{nodeName(ws, r.node)}</td>
                <td className="num">{r.onHand}</td>
                <td className="num">{r.incoming + r.pendingApprovalQty || "–"}</td>
                <td>{r.daysOfCover} d</td>
                <td><PositionBar r={r} /></td>
                <td><HealthBadge h={r.health} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="muted" style={{ padding: 12 }}>No matching products.</div>}
      </div>
    </div>
  );
}
