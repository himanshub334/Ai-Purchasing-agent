import { useEffect, useState } from "react";
import Automation from "./Automation";
import DemoClock from "./DemoClock";
import { DrawerHost } from "./Drawers";
import Inventory from "./Inventory";
import Lab from "./Lab";
import Orders from "./Orders";
import Suppliers from "./Suppliers";
import Today from "./Today";
import { useStore, WorkspaceProvider } from "./store";
import { Toasts } from "./ui";

const PAGES = [["today", "Today"], ["inventory", "Inventory"], ["orders", "Orders"], ["suppliers", "Suppliers"], ["automation", "Automation"]] as const;
const ids = [...PAGES.map((p) => p[0]), "developer"] as string[];
const fromHash = () => { const h = location.hash.replace("#/", ""); return ids.includes(h) ? h : "today"; };

function Shell() {
  const { ws, error } = useStore();
  const [page, setPage] = useState(fromHash());
  useEffect(() => { const f = () => setPage(fromHash()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  const go = (p: string) => { location.hash = `#/${p}`; };
  const decisions = ws ? ws.approvals.filter((a) => a.status === "pending").length + ws.escalations.filter((e) => e.status === "open").length : 0;
  const badge: Record<string, number> = { today: decisions, orders: ws?.approvals.filter((a) => a.status === "pending").length ?? 0 };
  const mode = ws?.settings.mode;
  return (
    <div className="shell2">
      <nav className="nav" aria-label="Main">
        <div className="brand-row"><span className="logo" aria-hidden>◆</span><div className="brand">Buyer</div></div>
        {PAGES.map(([id, label]) => (
          <a key={id} href={`#/${id}`} className={`navi ${page === id ? "on" : ""}`} aria-current={page === id ? "page" : undefined}>
            {label}{badge[id] ? <span className="count">{badge[id]}</span> : null}
          </a>
        ))}
        <div className="navgap" />
        <a href="#/developer" className={`navi dev ${page === "developer" ? "on" : ""}`}>Developer</a>
        <div className="agentstat small" role="status">
          <span className={`pulse ${mode === "paused" ? "off" : ""}`} aria-hidden />
          {mode === "paused" ? "Agent paused" : ws?.busy ? "Agent working…" : "Agent watching"}
        </div>
      </nav>
      <div className="content">
        <header className="topbar"><span className="muted small">{page === "developer" ? "Scenario lab and evaluation suite" : ""}</span><DemoClock /></header>
        {error && <div className="banner" role="alert">{error}</div>}
        <main className="page">
          {page === "today" && <Today go={go} />}
          {page === "inventory" && <Inventory />}
          {page === "orders" && <Orders />}
          {page === "suppliers" && <Suppliers />}
          {page === "automation" && <Automation />}
          {page === "developer" && <Lab />}
        </main>
      </div>
      <DrawerHost />
      <Toasts />
    </div>
  );
}

export default function App() {
  return <WorkspaceProvider><Shell /></WorkspaceProvider>;
}
