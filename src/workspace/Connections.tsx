import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { announceSignedOut } from "../accountEvents";
import { auth } from "../backend/auth";
import { Button } from "../components/Button";
import type { ConnectionInfo, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { actingAs, oldestCheck, probeDecides, rowAfter, statusLine, syncLine, type LineTone } from "./connectionsLogic";
import { useConnectionsUi } from "./connectionsUi";
import { disconnectGithub, useGithubUi } from "./githubUi";
import { useJiraUi } from "./jiraUi";
import { keyInitials } from "./projects";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { agoText, nounFor, watchSummary } from "./watchLogic";

const BEAD: Record<LineTone, string> = {
  ok: "[--c:var(--color-ws-done)]",
  quiet: "[--c:var(--color-ws-ink3)]",
  unsure: "[--c:var(--color-ws-warn)]",
  error: "[--c:var(--color-ws-blocked)]",
  busy: "[--c:var(--color-ws-accent)]",
};

function Spinner() {
  return <span data-spinner aria-hidden className="size-2 animate-spin rounded-full border-[1.5px] border-ws-accent border-t-transparent motion-reduce:animate-none" />;
}

function badgeText(c: ConnectionInfo) {
  return c.kind === "mock" ? "SD" : c.kind === "jira" ? "JI" : keyInitials(c.workspace);
}

export interface ConnectionsViewProps {
  connections: ConnectionInfo[];
  selectedId: string;
  watch: WatchState[];
  now: Date;
  checking: boolean;
  /** The GitHub connection whose Disconnect is being confirmed. */
  confirming: string | null;
  /** The GitHub connection being disconnected. */
  busy: string | null;
  copied: boolean;
  onSelect(id: string): void;
  onCheck(): void;
  onSync(): void;
  onCopy(command: string): void;
  onManage(): void;
  onNewToken(): void;
  onSignOut(): void;
  onAskDisconnect(): void;
  onCancel(): void;
  onDisconnect(): void;
  onConnectGithub(): void;
}

function Row({ c, selected, checking, onSelect }: { c: ConnectionInfo; selected: boolean; checking: boolean; onSelect(): void }) {
  const line = statusLine(c, checking);
  return (
    <li aria-label={`${c.displayName} connection`} className="border-b border-ws-sep last:border-b-0">
      <button
        type="button"
        data-connection={c.id}
        aria-current={selected || undefined}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        className={`flex w-full items-center gap-3 px-2 py-2.5 text-left outline-offset-[-2px] ${selected ? "ws-lens-row" : "hover:bg-ws-hover"}`}
      >
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-ws-sel text-xs font-bold text-ws-ink2">
          {badgeText(c)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{c.displayName}</span>
          <span data-line={line.tone} className={`ws-state ${BEAD[line.tone]} max-w-full text-sm text-ws-ink2`}>
            {line.tone === "busy" && <Spinner />}
            <span className="truncate">{line.text}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-4 gap-y-1 border-b border-ws-sep py-2.5 last:border-b-0">
      <h4 className="m-0 pt-0.5 text-sm font-semibold text-ws-ink2">{label}</h4>
      <div className="grid min-w-0 gap-1.5 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function StatusField({ c, p }: { c: ConnectionInfo; p: ConnectionsViewProps }) {
  const s = c.status;
  const loud = s !== null && probeDecides(c) && (s.state === "notSignedIn" || s.state === "notFound");
  const jira = c.kind !== "github";
  const needsToken = jira && s !== null && (s.state === "expiresSoon" || s.state === "notSignedIn");
  if (!c.enabled || s?.state === "off") return <p className="m-0 text-ws-ink3">Off.</p>;
  if (!s) return <p className="m-0 text-ws-ink3">{c.kind === "mock" ? "Built-in sample tickets. Nothing is sent anywhere." : "Not checked yet."}</p>;
  return (
    <>
      <p data-probe={s.state} role={loud ? "status" : undefined} className={`m-0 ${loud ? "text-ws-blocked" : "text-ws-ink"}`}>
        {s.message}
      </p>
      {s.fix && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="selectable rounded bg-ws-sel px-1.5 py-0.5 font-mono text-xs">{s.fix}</code>
          <Button size="sm" onClick={() => p.onCopy(s.fix as string)}>
            {p.copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {needsToken && (
          <Button variant="primary" size="sm" onClick={p.onNewToken}>
            Make a new token
          </Button>
        )}
        <Button size="sm" disabled={p.checking} onClick={p.onCheck}>
          {s.fix ? "I've run it, check again" : "Check again"}
        </Button>
        <span className="text-sm text-ws-ink3">Checked {agoText(s.checkedAt, p.now)}</span>
      </div>
    </>
  );
}

function Detail({ c, p }: { c: ConnectionInfo; p: ConnectionsViewProps }) {
  const sync = syncLine(c, p.now);
  const watch = p.watch.find((w) => w.connectionId === c.id);
  const sample = c.kind === "mock";
  return (
    <section aria-label={`${c.displayName} details`} className="pt-3">
      <h3 className="font-display m-0 mb-1 text-base font-semibold">{c.displayName}</h3>
      <Field label="Status">
        <StatusField c={c} p={p} />
      </Field>
      {!sample && (
        <Field label="Account">
          <p className="m-0">{c.kind === "github" ? c.workspace : c.account}</p>
          <div className="flex flex-wrap gap-2">
            {c.kind === "github" ? (
              <Button variant="quiet" size="sm" destructive disabled={p.busy === c.id} onClick={p.onAskDisconnect}>
                Disconnect
              </Button>
            ) : (
              <>
                <Button variant="quiet" size="sm" onClick={p.onNewToken}>
                  Change account
                </Button>
                <Button variant="quiet" size="sm" destructive onClick={p.onSignOut}>
                  Sign out
                </Button>
              </>
            )}
          </div>
          {c.kind === "github" && p.confirming === c.id && (
            <div role="alertdialog" aria-label={`Disconnect ${c.workspace}`} className="grid gap-2 border-t border-ws-sep pt-2 text-sm">
              <p className="m-0">Disconnect {c.workspace}? Gossamr forgets its token and deletes the pull requests and branches it cached. Nothing on GitHub changes.</p>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" disabled={p.busy === c.id} onClick={p.onDisconnect}>
                  {p.busy === c.id ? "Disconnecting…" : "Disconnect"}
                </Button>
                <Button variant="quiet" size="sm" disabled={p.busy === c.id} onClick={p.onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Field>
      )}
      <Field label="Sync">
        <p role={sync.tone === "ok" ? undefined : "status"} className={`m-0 text-sm ${sync.tone === "error" ? "text-ws-blocked" : "text-ws-ink2"}`}>
          {sync.text}
        </p>
        <div>
          <Button variant="quiet" size="sm" disabled={c.syncing} onClick={p.onSync}>
            Sync now
          </Button>
        </div>
      </Field>
      <Field label="Watching">
        <p className="m-0">{watchSummary(watch, nounFor(c.kind))}</p>
        <div>
          <Button variant="quiet" size="sm" onClick={p.onManage}>
            {c.kind === "github" ? "Manage repositories" : "Manage projects"}
          </Button>
        </div>
      </Field>
      {!sample && <Field label={c.kind === "github" ? "Host" : "Site"}>{c.kind === "github" ? "github.com" : c.workspace}</Field>}
      {actingAs(c).map((line) => (
        <p key={line} className="m-0 border-b border-ws-sep py-2.5 text-sm text-ws-ink2 last:border-b-0">
          {line}
        </p>
      ))}
    </section>
  );
}

export function ConnectionsView(p: ConnectionsViewProps) {
  const list = useRef<HTMLUListElement>(null);
  const selected = p.connections.find((c) => c.id === p.selectedId) ?? p.connections[0];
  const checked = oldestCheck(p.connections);
  const onKeyDown = (ev: KeyboardEvent) => {
    const next = rowAfter(p.connections.map((c) => c.id), selected?.id ?? null, ev.key);
    if (!next) return;
    ev.preventDefault();
    p.onSelect(next);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-connection="${next}"]`)?.focus());
  };
  const hasGithub = p.connections.some((c) => c.kind === "github");
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-sm text-ws-ink3">
        <span>{checked ? `Checked ${agoText(checked, p.now)}` : ""}</span>
        <Button variant="quiet" size="sm" disabled={p.checking} onClick={p.onCheck}>
          Check all
        </Button>
      </div>
      <ul ref={list} aria-label="Connections" onKeyDown={onKeyDown} className="m-0 grid list-none gap-0 border-y border-ws-sep p-0">
        {p.connections.map((c) => (
          <Row key={c.id} c={c} selected={c.id === selected?.id} checking={p.checking} onSelect={() => p.onSelect(c.id)} />
        ))}
      </ul>
      {selected && <Detail c={selected} p={p} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
        <span className="min-w-0 flex-1 text-sm text-ws-ink3">See the pull requests, branches and checks behind each ticket.</span>
        <Button variant={hasGithub ? "secondary" : "primary"} onClick={p.onConnectGithub}>
          {hasGithub ? "Connect another GitHub account" : "Connect GitHub"}
        </Button>
      </div>
    </div>
  );
}

export function ConnectionsSection({ now }: { now: Date }) {
  const connections = useWorkspace((s) => s.connections);
  const watch = useWorkspace((s) => s.watch);
  const selectedId = useConnectionsUi((s) => s.selected);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const current = connections.find((c) => c.id === selectedId) ?? connections[0];
  const select = (id: string) => {
    setConfirming(null);
    setCopied(false);
    useConnectionsUi.getState().select(id);
  };
  const check = async () => {
    setChecking(true);
    try {
      await useWorkspace.getState().refreshConnections(true);
    } finally {
      setChecking(false);
    }
  };
  const signOut = async () => {
    try {
      await auth.signOut();
      announceSignedOut();
    } catch (e) {
      useWorkspace.getState().report("Couldn't sign out", e);
    }
  };
  return (
    <ConnectionsView
      connections={connections}
      selectedId={current?.id ?? ""}
      watch={watch}
      now={now}
      checking={checking}
      confirming={confirming}
      busy={current && pending.includes(current.id) ? current.id : null}
      copied={copied}
      onSelect={select}
      onCheck={() => void check()}
      onSync={() => void useWorkspace.getState().syncNow()}
      onCopy={(command) =>
        navigator.clipboard?.writeText(command).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => useToasts.getState().push("Couldn't copy it. Select it and copy by hand."),
        )
      }
      onManage={() => useTabs.getState().openSettings("watching")}
      onNewToken={() => useJiraUi.getState().openConnect()}
      onSignOut={() => void signOut()}
      onAskDisconnect={() => setConfirming(current?.id ?? null)}
      onCancel={() => setConfirming(null)}
      onDisconnect={() => {
        const target = connections.find((c) => c.id === confirming);
        if (!target) return;
        setPending((ids) => [...ids, target.id]);
        void disconnectGithub(target.id, target.workspace)
          .then((ok) => {
            if (ok) setConfirming((now) => (now === target.id ? null : now));
          })
          .finally(() => setPending((ids) => ids.filter((id) => id !== target.id)));
      }}
      onConnectGithub={() => useGithubUi.getState().openConnect()}
    />
  );
}
