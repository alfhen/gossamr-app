import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Switch } from "../components/Switch";
import { nameProblem, NAME_LIMIT } from "../lib/connectionName";
import type { ConnectionInfo, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { removeConnection } from "./connectionRemoval";
import { setConnectionEnabled } from "./connectionToggle";
import { actingAs, oldestCheck, probeDecides, removalWarning, rowAfter, statusLine, syncLine, type LineTone } from "./connectionsLogic";
import { useConnectionsUi } from "./connectionsUi";
import { useGithubUi } from "./githubUi";
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
  /** The connection whose Remove is being confirmed. */
  confirming: string | null;
  /** The connection being removed. */
  busy: string | null;
  copied: boolean;
  /** The instances whose switch was just pressed and whose answer hasn't come back. */
  toggling: string[];
  onSelect(id: string): void;
  onCheck(): void;
  onSync(): void;
  onCopy(command: string): void;
  onOpenTerminal(): void;
  /** Resolves true when the name was saved. */
  onRename(name: string): Promise<boolean>;
  onManage(): void;
  onNewToken(): void;
  onAskRemove(): void;
  onCancel(): void;
  onRemove(): void;
  onToggle(c: ConnectionInfo, on: boolean): void;
  onConnectGithub(): void;
}

interface RowProps {
  c: ConnectionInfo;
  selected: boolean;
  checking: boolean;
  pending: boolean;
  onSelect(): void;
  onToggle(on: boolean): void;
}

function Row({ c, selected, checking, pending, onSelect, onToggle }: RowProps) {
  const line = statusLine(c, checking);
  return (
    <li aria-label={`${c.displayName} connection`} className="flex items-center gap-3 border-b border-ws-sep last:border-b-0">
      <button
        type="button"
        data-connection={c.id}
        aria-current={selected || undefined}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-3 px-2 py-2.5 text-left outline-offset-[-2px] ${selected ? "ws-lens-row" : "hover:bg-ws-hover"}`}
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
      {c.kind !== "mock" && (
        <span className="shrink-0 pr-2">
          <Switch checked={c.enabled} pending={pending} onChange={onToggle} aria-label={c.displayName} />
        </span>
      )}
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
          <Button size="sm" onClick={p.onOpenTerminal}>
            Open Terminal
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

const FIELD = "min-w-0 rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 font-normal outline-none focus:border-ws-accent";

function NameField({ name, onRename }: { name: string; onRename(name: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (draft === null) {
    return (
      <>
        <p className="m-0">{name}</p>
        <div>
          <Button variant="quiet" size="sm" onClick={() => setDraft(name)}>
            Rename
          </Button>
        </div>
      </>
    );
  }
  const problem = nameProblem(draft);
  const save = async () => {
    if (problem || saving) return;
    if (draft.trim() === name) return setDraft(null);
    setSaving(true);
    try {
      if (await onRename(draft.trim())) setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
      className="grid gap-2"
    >
      <input
        aria-label="Display name"
        value={draft}
        disabled={saving}
        maxLength={NAME_LIMIT * 2}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key !== "Escape") return;
          ev.stopPropagation();
          setDraft(null);
        }}
        className={FIELD}
      />
      {problem && draft !== "" && (
        <p role="status" className="m-0 text-sm text-ws-blocked">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={problem !== null || saving}>
          Save
        </Button>
        <Button variant="quiet" size="sm" disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </form>
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
        <Field label="Name">
          <NameField name={c.displayName} onRename={p.onRename} />
        </Field>
      )}
      {!sample && (
        <Field label="Account">
          <p className="m-0">{c.kind === "github" ? c.workspace : c.account}</p>
          <div className="flex flex-wrap gap-2">
            {c.kind !== "github" && (
              <Button variant="quiet" size="sm" onClick={p.onNewToken}>
                Change account
              </Button>
            )}
            <Button variant="quiet" size="sm" destructive disabled={p.busy === c.id} onClick={p.onAskRemove}>
              Remove
            </Button>
          </div>
          {p.confirming === c.id && (
            <div role="alertdialog" aria-label={`Remove ${c.displayName}`} className="grid gap-2 border-t border-ws-sep pt-2 text-sm">
              <p className="m-0">{removalWarning(c)}</p>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" disabled={p.busy === c.id} onClick={p.onRemove}>
                  {p.busy === c.id ? "Removing…" : "Remove"}
                </Button>
                <Button variant="quiet" size="sm" autoFocus disabled={p.busy === c.id} onClick={p.onCancel}>
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
          <Button variant="quiet" size="sm" disabled={c.syncing || !c.enabled} onClick={p.onSync}>
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
          <Row key={c.id} c={c} selected={c.id === selected?.id} checking={p.checking} pending={p.toggling.includes(c.instanceId)} onSelect={() => p.onSelect(c.id)} onToggle={(on) => p.onToggle(c, on)} />
        ))}
      </ul>
      {selected && <Detail key={selected.id} c={selected} p={p} />}
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
  const [busy, setBusy] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string[]>([]);
  const current = connections.find((c) => c.id === selectedId) ?? connections[0];
  const select = (id: string) => {
    setConfirming(null);
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
  const openTerminal = async (c: ConnectionInfo | undefined) => {
    const backend = useWorkspace.getState().backend;
    if (!c || !backend) return;
    try {
      await backend.connectionOpenTerminal(c.instanceId);
    } catch (e) {
      useWorkspace.getState().report("Couldn't open Terminal", e);
    }
  };
  const toggle = async (c: ConnectionInfo, on: boolean) => {
    setToggling((now) => [...now, c.instanceId]);
    try {
      await setConnectionEnabled(c, on);
    } finally {
      setToggling((now) => now.filter((id) => id !== c.instanceId));
    }
  };
  const rename = async (c: ConnectionInfo | undefined, name: string) => {
    const backend = useWorkspace.getState().backend;
    if (!c || !backend) return false;
    try {
      await backend.connectionRename(c.instanceId, name);
      await useWorkspace.getState().refreshConnections();
      return true;
    } catch (e) {
      useWorkspace.getState().report("Couldn't rename it", e);
      return false;
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
      busy={busy}
      copied={copied}
      toggling={toggling}
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
      onOpenTerminal={() => void openTerminal(current)}
      onRename={(name) => rename(current, name)}
      onManage={() => useTabs.getState().openSettings("watching")}
      onNewToken={() => useJiraUi.getState().openConnect()}
      onAskRemove={() => setConfirming(current?.id ?? null)}
      onCancel={() => setConfirming(null)}
      onRemove={() => {
        const target = connections.find((c) => c.id === confirming);
        if (!target) return;
        setBusy(target.id);
        void removeConnection(target)
          .then((ok) => {
            if (ok) setConfirming(null);
          })
          .finally(() => setBusy(null));
      }}
      onToggle={(c, on) => void toggle(c, on)}
      onConnectGithub={() => useGithubUi.getState().openConnect()}
    />
  );
}
