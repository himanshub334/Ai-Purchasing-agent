import { useState } from "react";
import Lab from "./Lab";
import Live from "./Live";

export default function App() {
  const [view, setView] = useState<"live" | "lab">("live");
  return (
    <div className="shell">
      <header className="top">
        <div className="brand-row">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <div className="brand">AI Purchasing Agent</div>
            <div className="sub" style={{ margin: 0 }}>Monitors stock, decides, orders, verifies</div>
          </div>
        </div>
        <nav className="topnav" role="tablist">
          <button role="tab" aria-selected={view === "live"} className={`tab ${view === "live" ? "on" : ""}`} onClick={() => setView("live")}>Live workspace</button>
          <button role="tab" aria-selected={view === "lab"} className={`tab ${view === "lab" ? "on" : ""}`} onClick={() => setView("lab")}>Scenario lab &amp; evals</button>
        </nav>
      </header>
      {view === "live" ? <Live /> : <Lab />}
    </div>
  );
}
