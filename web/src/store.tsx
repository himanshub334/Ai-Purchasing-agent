import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { agentHeadline } from "./format";
import type { Workspace } from "./types";

export type Drawer = { type: "item"; sku: string; node: string } | { type: "order"; id: string } | { type: "newOrder"; sku?: string; node?: string } | null;
export interface Toast { id: number; text: string; tone: "ok" | "warn" | "info" }

interface Store {
  ws: Workspace | null;
  error: string;
  busy: boolean;
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  update: (w: Workspace) => void;
  drawer: Drawer;
  openDrawer: (d: Drawer) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  anthropicOk: boolean;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
};

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [anthropicOk, setAnthropicOk] = useState(false);
  const acting = useRef(false);
  const lastSeq = useRef<number | null>(null);
  const toastId = useRef(0);

  const pushToast = useCallback((text: string, tone: Toast["tone"]) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  // Tell the user when the agent did something while they were looking elsewhere.
  const update = useCallback((w: Workspace) => {
    const maxSeq = w.feed.reduce((m, f) => Math.max(m, f.seq), 0);
    if (lastSeq.current !== null) {
      const fresh = w.feed.filter((f) => f.kind === "agent" && f.seq > lastSeq.current!).reverse();
      for (const f of fresh) {
        if (f.kind !== "agent") continue;
        const h = agentHeadline(w, f);
        pushToast(h.lines[0] ?? f.text, h.tone === "attention" ? "warn" : h.tone === "waiting" ? "warn" : "ok");
      }
    }
    lastSeq.current = maxSeq;
    setWs(w);
  }, [pushToast]);

  useEffect(() => { api.health().then((h) => setAnthropicOk(h.anthropicConfigured)).catch(() => undefined); }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (acting.current) return;
      api.workspace().then((w) => { if (alive) { update(w); setError(""); } }).catch((e) => alive && setError(`Can't reach the server: ${e.message}`));
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [update]);

  const act = useCallback(async <T,>(fn: () => Promise<T>) => {
    acting.current = true; setBusy(true); setError("");
    try { return await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; } finally { acting.current = false; setBusy(false); }
  }, []);

  const value = useMemo<Store>(() => ({
    ws, error, busy, act, update, drawer, openDrawer: setDrawer, toasts,
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)), anthropicOk,
  }), [ws, error, busy, act, update, drawer, toasts, anthropicOk]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
