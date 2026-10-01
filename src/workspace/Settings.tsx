import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { announceSignedOut } from "../accountEvents";
import { auth } from "../backend/auth";
import type { ConnectionInfo, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useAgentsFlag } from "./agentsFlag";
import { AgentsSwitch } from "./AgentsSwitch";
import { THEME_LABEL, THEMES, usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { agoText, count, nounFor, watchSummary } from "./watchLogic";
import { keyInitials } from "./projects";
import { disconnectGithub, useGithubUi } from "./githubUi";
import { workContainers } from "./domains";
import { WatchingSection } from "./WatchSettings";

export function connectionsOf(containers: { ref: { connectionId: string } }[]): { id: string; name: string; projects: number }[] {
  const counts = new Map<string, number>();
  for (const c of containers) counts.set(c.ref.connectionId, (counts.get(c.ref.connectionId) ?? 0) + 1);
  return [...counts].map(([id, projects]) => ({ id, name: id === "mock" ? "Sample data" : id, projects }));
}

/** What the connection row says about the sync. */
export function syncLine(c: Pick<ConnectionInfo, "syncing" | "lastSyncAt" | "error">, now: Date): { text: string; tone: "ok" | "busy" | "error" } {
  if (c.syncing) return { text: "Syncing…", tone: "busy" };
  const last = c.lastSyncAt ? `Last synced ${agoText(c.lastSyncAt, now)}` : "Not synced yet";
  return c.error ? { text: `${last}. Couldn't sync: ${c.error}`, tone: "error" } : { text: last, tone: "ok" };
}

const DOT = { ok: "bg-ws-done", busy: "bg-ws-accent", error: "bg-ws-blocked" } as const;

const CARD = "grid gap-1.5 rounded-xl border border-ws-sep2 bg-ws-win p-4";

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function SyncStatus({ line }: { line: ReturnType<typeof syncLine> }) {
  return (
    <p role="status" className={`m-0 text-sm [overflow-wrap:anywhere] ${line.tone === "error" ? "text-ws-blocked" : "text-ws-ink3"}`}>
      {line.text}
    </p>
  );
}

function KindBadge({ children, round = false }: { children: ReactNode; round?: boolean }) {
  return (
    <span aria-hidden className={`grid size-8 shrink-0 place-items-center bg-ws-sel text-xs font-bold text-ws-ink2 ${round ? "rounded-full" : "rounded-lg"}`}>
      {children}
    </span>
  );
}

function SyncNow({ c }: { c: ConnectionInfo }) {
  return (
    <button type="button" disabled={c.syncing} onClick={() => void useWorkspace.getState().syncNow()} className="text-ws-accent underline disabled:opacity-50 disabled:no-underline">
      Sync now
    </button>
  );
}

function ConnectionRow({ c, projects }: { c: ConnectionInfo; projects: number }) {
  const now = useNow();
  const [signingOut, setSigningOut] = useState(false);
  const line = syncLine(c, now);
  const sample = c.kind === "mock";
  const signOut = async () => {
    setSigningOut(true);
    try {
      await auth.signOut();
      announceSignedOut();
    } catch (e) {
      useWorkspace.getState().report("Couldn't sign out", e);
      setSigningOut(false);
    }
  };
  return (
    <li className={CARD} aria-label={`${c.workspace} connection`}>
      <div className="flex items-center gap-3">
        <KindBadge>{sample ? "SD" : "JI"}</KindBadge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${DOT[line.tone]}`} aria-hidden />
            <span className="truncate font-semibold">{c.workspace}</span>
            <span className="rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink2">{sample ? "Sample data" : "Jira"}</span>
          </div>
          <div className="truncate text-sm text-ws-ink3">{sample ? "Built-in sample tickets. Nothing is sent anywhere." : c.account}</div>
        </div>
        <span className="shrink-0 text-ws-ink3">{count(projects, nounFor(c.kind))}</span>
      </div>
      <SyncStatus line={line} />
      <div className="flex gap-3 text-sm">
        <SyncNow c={c} />
        {c.kind === "jira" && (
          <button type="button" disabled={signingOut} onClick={() => void signOut()} className="text-ws-ink2 underline disabled:opacity-50">
            Sign out
          </button>
        )}
      </div>
    </li>
  );
}

export function GithubCardView({ c, watch, now, confirming, busy, onSync, onManage, onAskDisconnect, onCancel, onDisconnect }: {
  c: ConnectionInfo;
  watch: WatchState | undefined;
  now: Date;
  confirming: boolean;
  busy: boolean;
  onSync(): void;
  onManage(): void;
  onAskDisconnect(): void;
  onCancel(): void;
  onDisconnect(): void;
}) {
  const line = syncLine(c, now);
  return (
    <li className={CARD} aria-label={`GitHub account ${c.workspace}`}>
      <div className="flex items-center gap-3">
        <KindBadge round>{keyInitials(c.workspace)}</KindBadge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${DOT[line.tone]}`} aria-hidden />
            <span className="truncate font-semibold">{c.workspace}</span>
            <span className="rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink2">GitHub</span>
          </div>
          <div className="truncate text-sm text-ws-ink3">{c.account}</div>
        </div>
      </div>
      <p className="m-0 text-sm text-ws-ink2">{watchSummary(watch, nounFor("github"))}</p>
      <SyncStatus line={line} />
      <div className="flex flex-wrap gap-3 text-sm">
        <button type="button" disabled={c.syncing} onClick={onSync} className="text-ws-accent underline disabled:opacity-50 disabled:no-underline">
          Sync now
        </button>
        <button type="button" onClick={onManage} className="text-ws-accent underline">
          Manage repositories
        </button>
        <button type="button" disabled={busy} onClick={onAskDisconnect} className="text-ws-ink2 underline disabled:opacity-50">
          Disconnect
        </button>
      </div>
      {confirming && (
        <div role="alertdialog" aria-label={`Disconnect ${c.workspace}`} className="mt-1 grid gap-2 rounded-lg border border-ws-warn bg-ws-bar px-3 py-2.5 text-sm">
          <p className="m-0 text-ws-ink">Disconnect {c.workspace}? Gossamr forgets its token and deletes the pull requests and branches it cached. Nothing on GitHub changes, and you can connect again any time.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={onDisconnect} className="rounded-md bg-ws-blocked px-3 py-1 font-semibold text-white disabled:opacity-50">
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className="rounded-md px-3 py-1 text-ws-ink2 hover:bg-ws-hover">
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function GithubCard({ c }: { c: ConnectionInfo }) {
  const now = useNow();
  const watch = useWorkspace((s) => s.watch.find((w) => w.connectionId === c.id));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <GithubCardView
      c={c}
      watch={watch}
      now={now}
      confirming={confirming}
      busy={busy}
      onSync={() => void useWorkspace.getState().syncNow()}
      onManage={() => useTabs.getState().openSettings("watching")}
      onAskDisconnect={() => setConfirming(true)}
      onCancel={() => setConfirming(false)}
      onDisconnect={() => {
        setBusy(true);
        void disconnectGithub(c.id, c.workspace).then((ok) => {
          setBusy(false);
          if (ok) setConfirming(false);
        });
      }}
    />
  );
}

export function ConnectGithubCard({ connected }: { connected: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-ws-sep2 p-4">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{connected ? "Connect another GitHub account" : "Connect GitHub"}</div>
        <div className="text-sm text-ws-ink3">See the pull requests, branches and checks behind each ticket. Read-only: Gossamr never comments, merges or pushes.</div>
      </div>
      <button type="button" onClick={() => useGithubUi.getState().openConnect()} className="shrink-0 rounded-lg bg-ws-accent px-3.5 py-1.5 font-semibold text-white">
        Connect GitHub
      </button>
    </li>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-b border-ws-sep py-5">
      <h2 className="m-0 mb-2.5 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Settings() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const setUi = usePrefs((s) => s.setUi);
  const agents = useAgentsFlag();
  const containers = useWorkspace((s) => s.containers);
  const connections = useWorkspace((s) => s.connections);
  const section = useTabs((s) => s.settingsSection);
  useEffect(() => {
    if (!section) return;
    document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" });
    useTabs.setState({ settingsSection: null });
  }, [section]);
  const projects = useMemo(() => new Map(connectionsOf(workContainers(Object.values(containers))).map((c) => [c.id, c.projects])), [containers]);

  return (
    <div className="h-full overflow-auto px-8 pb-10">
      <h1 className="m-0 pt-6 text-xl font-bold">Settings</h1>
      <div className="max-w-[720px]">
        <Section title="Theme">
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg bg-ws-sel p-0.5">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={`rounded-md px-3.5 py-1 font-semibold ${theme === t ? "bg-ws-win text-ws-ink shadow-sm" : "text-ws-ink2"}`}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Connections">
          <ul aria-label="Connections" className="m-0 grid list-none gap-3 p-0">
            {connections.map((c) => (c.kind === "github" ? <GithubCard key={c.id} c={c} /> : <ConnectionRow key={c.id} c={c} projects={projects.get(c.id) ?? 0} />))}
            <ConnectGithubCard connected={connections.some((c) => c.kind === "github")} />
          </ul>
        </Section>

        <Section title="Watching" id="settings-watching">
          <WatchingSection syncLine={syncLine} />
        </Section>

        {isTauri() && (
          <Section title="Agents">
            <AgentsSwitch enabled={agents.enabled} pending={agents.pending} error={agents.error} note={agents.note} onChange={(on) => void agents.set(on)} />
          </Section>
        )}

        <Section title="Autopilot">
          <p className="m-0 text-ws-ink3">Off. Rules that let Pip draft routine updates for you will be configured here, per project.</p>
        </Section>

        {isTauri() && (
          <Section title="Interface">
            <button type="button" className="text-ws-accent underline" onClick={() => setUi("classic")}>
              Go back to the classic inbox
            </button>
          </Section>
        )}
      </div>
    </div>
  );
}
