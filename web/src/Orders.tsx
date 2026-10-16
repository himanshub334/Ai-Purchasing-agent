import { useState } from "react";
import { nodeName, SOURCE, shortDate, STATUS, usd } from "./format";
import { useStore } from "./store";
import { Badge, Empty } from "./ui";

const FILTERS = [["all", "All"], ["pending_approval", "Needs approval"], ["open", "On order"], ["received", "Received"], ["cancelled", "Cancelled"]] as const;

export default function Orders() {
  const { ws, openDrawer } = useStore();
  const [f, setF] = useState<string>("all");
  if (!ws) return <Empty>Loading…</Empty>;
  const orders = [...ws.orders].filter((o) => f === "all" || o.status === f).sort((a, b) => b.id.localeCompare(a.id));
  return (
    <div>
      <div className="phead">
        <div><h1>Orders</h1><p className="lede">Every purchase order, whether you or the agent placed it.</p></div>
        <button className="btn" onClick={() => openDrawer({ type: "newOrder" })}>New order</button>
      </div>
      <div className="tabs" role="tablist">
        {FILTERS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={f === k} className={`tab ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
            {l} <span className="muted small">{k === "all" ? ws.orders.length : ws.orders.filter((o) => o.status === k).length}</span>
          </button>
        ))}
      </div>
      <div className="card">
        <table className="board">
          <thead><tr><th>Order</th><th>Product</th><th>Supplier</th><th>Location</th><th className="num">Qty</th><th className="num">Value</th><th>Arrives</th><th>Placed by</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="click" tabIndex={0} onClick={() => openDrawer({ type: "order", id: o.id })} onKeyDown={(e) => e.key === "Enter" && openDrawer({ type: "order", id: o.id })}>
                <td className="mono">{o.id}</td>
                <td>{o.name}</td>
                <td>{o.supplierName}</td>
                <td>{nodeName(ws, o.node)}</td>
                <td className="num">{o.qty}{o.confirmedQty !== o.qty && o.status === "open" && <span className="warn small"> ({o.confirmedQty} confirmed)</span>}</td>
                <td className="num">{usd(o.valueUsd)}</td>
                <td>{shortDate(o.eta)}</td>
                <td>{SOURCE[o.createdBy]}</td>
                <td><Badge tone={STATUS[o.status]?.tone ?? "b-info"}>{STATUS[o.status]?.label ?? o.status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <div className="muted" style={{ padding: 12 }}>No orders here.</div>}
      </div>
    </div>
  );
}
