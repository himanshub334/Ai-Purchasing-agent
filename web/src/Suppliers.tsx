import { useEffect, useState } from "react";
import { api } from "./api";
import { usd, usd2 } from "./format";
import { useStore } from "./store";
import type { SupplierView } from "./types";
import { Badge, Empty } from "./ui";

export default function Suppliers() {
  const { ws } = useStore();
  const [list, setList] = useState<SupplierView[] | null>(null);
  const [err, setErr] = useState("");
  const orderCount = ws?.orders.length ?? 0;
  useEffect(() => { api.suppliers().then(setList).catch((e) => setErr(e.message)); }, [orderCount, ws?.simDate]);
  if (err) return <div className="err">{err}</div>;
  if (!list) return <Empty>Loading…</Empty>;
  return (
    <div>
      <div className="phead"><div><h1>Suppliers</h1><p className="lede">Who you buy from, on what terms, and how reliable they have been.</p></div></div>
      <div className="grid2">
        {list.map((s) => (
          <section className="card" key={s.id}>
            <div className="runhead" style={{ marginTop: 0 }}>
              <h3 className="sech">{s.name}</h3>
              <Badge tone={s.reliability >= 0.9 ? "b-ok" : "b-warn"}>{Math.round(s.reliability * 100)}% on time, in full</Badge>
            </div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              {s.openOrders} open order{s.openOrders === 1 ? "" : "s"} ({usd(s.openValueUsd)}) · {s.receivedOrders} received · {s.shortShipped} short-shipped
            </div>
            <table>
              <thead><tr><th>Product</th><th className="num">Unit</th><th className="num">Lead</th><th className="num">Min order</th><th className="num">Pack</th></tr></thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.sku}><td>{i.name}</td><td className="num">{usd2(i.unitCost)}</td><td className="num">{i.leadTimeDays} d</td><td className="num">{i.moq}</td><td className="num">{i.casePack}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
