import { useState } from "react";
import { api } from "./api";
import { nodeName, productName, shortDate } from "./format";
import { useStore } from "./store";

/** Simulation controls. Real life would not have these; they let a reviewer move time and cause incidents. */
export default function DemoClock() {
  const { ws, act, update, busy } = useStore();
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState("");
  const [mult, setMult] = useState(3);
  const [po, setPo] = useState("");
  const [short, setShort] = useState(0);
  const [speed, setSpeed] = useState(3000);
  if (!ws) return null;
  const sel = pair || `${ws.rows[0].sku}|${ws.rows[0].node}`;
  const [sku, node] = sel.split("|");
  const openPos = ws.orders.filter((o) => o.status === "open");
  const poSel = po || openPos[0]?.id || "";
  return (
    <div className="clock">
      <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden>◷</span> {shortDate(ws.simDate)}{ws.autopilot.enabled && <span className="live"> ● running</span>}
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label="Demo clock">
          <h3>Demo clock</h3>
          <p className="small muted">Simulation only. Move time forward and cause problems to see the agent react.</p>
          <div className="evrow">
            <button className="btn sm" disabled={busy} onClick={() => act(() => api.advance(1, "policy").then(update))}>Next day</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.advance(7, "policy").then(update))}>+7 days</button>
          </div>
          <label className="switch small">
            <input type="checkbox" checked={ws.autopilot.enabled} onChange={(e) => act(() => api.autopilot(e.target.checked, speed, "policy").then(update))} />
            <span className="track" /> Auto-advance
          </label>
          <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ marginLeft: 8 }}>
            <option value={1500}>fast</option><option value={3000}>normal</option><option value={6000}>slow</option>
          </select>
          <h4>Cause an event</h4>
          <div className="evrow">
            <select aria-label="Item" value={sel} onChange={(e) => setPair(e.target.value)}>
              {ws.rows.map((r) => <option key={r.sku + r.node} value={`${r.sku}|${r.node}`}>{productName(ws, r.sku)} · {nodeName(ws, r.node)}</option>)}
            </select>
            <select aria-label="Multiplier" value={mult} onChange={(e) => setMult(Number(e.target.value))}>
              {[2, 3, 4].map((m) => <option key={m} value={m}>×{m}</option>)}
            </select>
            <button className="btn sm" disabled={busy} onClick={() => act(() => api.event({ type: "sales_surge", sku, node, multiplier: mult }).then(update))}>Sales surge</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.event({ type: "sales_normal", sku, node }).then(update))}>Back to normal</button>
          </div>
          <div className="evrow">
            <select aria-label="Order" value={poSel} onChange={(e) => setPo(e.target.value)}>
              {openPos.map((o) => <option key={o.id} value={o.id}>{o.id} · {o.name} ({o.qty})</option>)}
            </select>
            <input className="input" type="number" min={0} aria-label="Confirmed quantity" style={{ width: 80 }} value={short} onChange={(e) => setShort(Number(e.target.value))} />
            <button className="btn sm" disabled={busy || !poSel} onClick={() => act(() => api.event({ type: "supplier_short", poId: poSel, confirmedQty: short }).then(update))}>Supplier ships less</button>
          </div>
          <div className="evrow">
            <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.event({ type: "add_budget", category: "grocery", amountUsd: 5000 }).then(update))}>+$5,000 grocery budget</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => confirm("Reset the whole demo?") && act(() => api.reset().then(update))}>Reset demo</button>
          </div>
        </div>
      )}
    </div>
  );
}
