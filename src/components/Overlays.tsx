import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { SHORTCUTS } from "../lib/keyboard";
import { ticketMatches, VIEWS } from "../lib/views";
import { useStore } from "../store";
import { StatusPill } from "./primitives";

interface PaletteEntry {
  id: string;
  label: string;
  ticketKey?: string;
  hint?: React.ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const { snap, backend, openOverlay, goToTicket, setView } = useStore();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const { tickets, actions } = useMemo(() => {
    if (!snap) return { tickets: [], actions: [] };
    const tickets: PaletteEntry[] = Object.values(snap.tickets)
      .filter((t) => ticketMatches(t, query))
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 30)
      .map((t) => ({ id: t.key, ticketKey: t.key, label: t.summary, hint: <StatusPill status={t.status} />, run: () => goToTicket(t.key) }));
    const all: PaletteEntry[] = [
      { id: "transition", label: "Transition current ticket", hint: "t", run: () => openOverlay("transition") },
      ...VIEWS.map((v) => ({ id: `view:${v.id}`, label: `Go to ${v.label}`, run: () => setView(v.id) })),
      { id: "sync", label: backend?.kind === "mock" ? "Simulate a new notification" : "Sync now", run: () => void backend?.syncNow() },
      { id: "help", label: "Keyboard shortcuts", hint: "?", run: () => openOverlay("help") },
    ];
    const q = query.trim().toLowerCase();
    return { tickets, actions: all.filter((a) => !q || a.label.toLowerCase().includes(q)) };
  }, [snap, query, backend, goToTicket, openOverlay, setView]);

  const entries = [...tickets, ...actions];
  const selected = Math.min(sel, Math.max(0, entries.length - 1));

  const pick = (e: PaletteEntry | undefined) => {
    if (!e) return;
    openOverlay(null);
    e.run();
  };

  const row = (e: PaletteEntry, i: number) => (
    <button
      key={e.id}
      type="button"
      aria-selected={i === selected}
      onMouseEnter={() => setSel(i)}
      onClick={() => pick(e)}
      className="flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left aria-selected:bg-accent aria-selected:text-white"
    >
      <span className="w-16 shrink-0 font-mono text-[11.5px] font-semibold opacity-75">{e.ticketKey}</span>
      <span className="truncate">{e.label}</span>
      <span className="ml-auto shrink-0 text-[11.5px] opacity-75">{e.hint}</span>
    </button>
  );

  return (
    <Scrim onClose={() => openOverlay(null)}>
      <div role="dialog" aria-label="Search" className="w-[min(600px,100%)] overflow-hidden rounded-xl border border-sep-strong bg-pop shadow-pop">
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(Math.min(entries.length - 1, selected + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(Math.max(0, selected - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(entries[selected]);
            } else if (e.key === "Escape") {
              openOverlay(null);
            }
          }}
          placeholder="Search tickets, or type a command…"
          className="w-full border-b border-sep bg-transparent px-4 py-3.5 text-[16px] outline-none"
        />
        <div className="max-h-[50vh] overflow-auto p-1.5">
          {tickets.length > 0 && <Heading>Tickets</Heading>}
          {tickets.map((e, i) => row(e, i))}
          {actions.length > 0 && <Heading>Actions</Heading>}
          {actions.map((e, i) => row(e, tickets.length + i))}
          {entries.length === 0 && <div className="px-5 py-8 text-center text-ink-3">No matches</div>}
        </div>
      </div>
    </Scrim>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs font-semibold text-ink-3">{children}</div>;
}

export function ShortcutHelp() {
  const openOverlay = useStore((s) => s.openOverlay);
  return (
    <Scrim onClose={() => openOverlay(null)}>
      <div role="dialog" aria-label="Keyboard shortcuts" className="grid w-[min(440px,100%)] gap-3 rounded-xl border border-sep-strong bg-pop px-5 py-4 shadow-pop">
        <h3 className="text-lg font-semibold">Keyboard shortcuts</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt className="text-right">
                <kbd>{k}</kbd>
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Scrim>
  );
}

export function ConnectClaude() {
  const openOverlay = useStore((s) => s.openOverlay);
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);

  const connect = async () => {
    setState("working");
    setError(null);
    try {
      await invoke("connect_claude_code");
      setState("done");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const showCommand = async () => {
    const c = await invoke<{ command: string }>("mcp_connection");
    setCommand(c.command);
  };

  return (
    <Scrim onClose={() => openOverlay(null)}>
      <div role="dialog" aria-label="Use Jira Inbox from Claude Code" className="selectable grid w-[min(520px,100%)] gap-3 rounded-xl border border-sep-strong bg-pop px-5 py-4 shadow-pop">
        <h3 className="text-lg font-semibold">Use Jira Inbox from Claude Code</h3>
        <p className="text-ink-2">
          Adds a <code className="font-mono text-sm">jira-inbox</code> MCP server to Claude Code for all your projects, so any session can ask
          what's new in your inbox, read tickets, comment and move them. Claude Code asks before each call, and the server only listens on
          this Mac while Jira Inbox is open.
        </p>
        {state === "done" ? (
          <p className="text-done">Added. Start a new Claude Code session and ask “what's new in my Jira inbox?”</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={state === "working"} onClick={() => void connect()} className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white disabled:opacity-45">
              {state === "working" ? "Adding…" : "Add to Claude Code"}
            </button>
            {!command && (
              <button type="button" className="text-accent" onClick={() => void showCommand()}>
                Show the command instead
              </button>
            )}
          </div>
        )}
        {command && <pre className="overflow-x-auto rounded-md bg-hover p-2.5 font-mono text-xs whitespace-pre-wrap break-all">{command}</pre>}
        {error && (
          <div role="alert" className="rounded-md bg-blocked-bg px-3 py-2 text-blocked">
            {error}
          </div>
        )}
      </div>
    </Scrim>
  );
}

function Scrim({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] grid items-start justify-items-center bg-black/20 px-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {children}
    </div>
  );
}

export function ToastHost() {
  const { toast, error } = useStore();
  const [visible, setVisible] = useState(toast);

  useEffect(() => {
    setVisible(toast);
    if (!toast) return;
    const t = setTimeout(() => setVisible(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => useStore.setState({ error: null }), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const base = "fixed bottom-5 left-1/2 z-[90] flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-[9px] py-2 pr-2.5 pl-3.5 text-[12.5px] text-white shadow-pop [animation:slide-in_.2s]";
  if (error) {
    return (
      <div role="alert" className={`${base} bg-blocked`}>
        {error}
        <button type="button" className="rounded bg-white/20 px-2 py-0.5" onClick={() => useStore.setState({ error: null })}>
          Dismiss
        </button>
      </div>
    );
  }
  if (!visible) return null;
  return (
    <div role="status" className={`${base} bg-[#2a2a2d]`}>
      {visible.message}
      {visible.undo && (
        <button
          type="button"
          className="rounded bg-white/15 px-2 py-0.5"
          onClick={() => {
            visible.undo?.();
            setVisible(null);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
