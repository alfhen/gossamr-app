import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { announceSignedOut } from "../accountEvents";
import { auth } from "../backend/auth";
import { relativeTime } from "../lib/views";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { THEME_LABEL, THEMES, usePrefs } from "./prefs";

export function connectionsOf(containers: { ref: { connectionId: string } }[]): { id: string; name: string; projects: number }[] {
  const counts = new Map<string, number>();
  for (const c of containers) counts.set(c.ref.connectionId, (counts.get(c.ref.connectionId) ?? 0) + 1);
  return [...counts].map(([id, projects]) => ({ id, name: id === "mock" ? "Sample data" : id, projects }));
}

const ago = (iso: string, now: Date) => {
  const r = relativeTime(iso, now);
  return r === "now" ? "just now" : /^\d+[mhd]$/.test(r) ? `${r} ago` : r;
};

/** What the connection row says about the sync. */
export function syncLine(c: Pick<ConnectionInfo, "syncing" | "lastSyncAt" | "error">, now: Date): { text: string; tone: "ok" | "busy" | "error" } {
  if (c.syncing) return { text: "Syncing…", tone: "busy" };
  const last = c.lastSyncAt ? `Last synced ${ago(c.lastSyncAt, now)}` : "Not synced yet";
  return c.error ? { text: `${last}. Couldn't sync: ${c.error}`, tone: "error" } : { text: last, tone: "ok" };
}

const DOT = { ok: "bg-ws-done", busy: "bg-ws-accent", error: "bg-ws-blocked" } as const;

function ConnectionRow({ c, projects }: { c: ConnectionInfo; projects: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [signingOut, setSigningOut] = useState(false);
  const line = syncLine(c, now);
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
    <li className="grid gap-1 border-b border-ws-sep py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${DOT[line.tone]}`} aria-hidden />
        <span className="font-semibold">{c.workspace}</span>
        <span className="text-ws-ink3">{c.account}</span>
        <span className="ml-auto text-ws-ink3">
          {projects} {projects === 1 ? "project" : "projects"}
        </span>
      </div>
      <p role="status" className={`m-0 pl-4 text-sm [overflow-wrap:anywhere] ${line.tone === "error" ? "text-ws-blocked" : "text-ws-ink3"}`}>
        {line.text}
      </p>
      <div className="flex gap-3 pl-4 text-sm">
        <button type="button" disabled={c.syncing} onClick={() => void useWorkspace.getState().syncNow()} className="text-ws-accent underline disabled:opacity-50 disabled:no-underline">
          Sync now
        </button>
        {c.kind === "jira" && (
          <button type="button" disabled={signingOut} onClick={() => void signOut()} className="text-ws-ink2 underline disabled:opacity-50">
            Sign out
          </button>
        )}
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-ws-sep py-5">
      <h2 className="m-0 mb-2.5 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Settings() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const setUi = usePrefs((s) => s.setUi);
  const containers = useWorkspace((s) => s.containers);
  const connections = useWorkspace((s) => s.connections);
  const projects = useMemo(() => new Map(connectionsOf(Object.values(containers)).map((c) => [c.id, c.projects])), [containers]);

  return (
    <div className="h-full overflow-auto px-8 pb-10">
      <h1 className="m-0 pt-6 text-xl font-bold">Settings</h1>
      <div className="max-w-[640px]">
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
          <ul className="m-0 list-none p-0">
            {connections.map((c) => (
              <ConnectionRow key={c.id} c={c} projects={projects.get(c.id) ?? 0} />
            ))}
            {!connections.length && <li className="text-ws-ink3">No connections yet.</li>}
          </ul>
        </Section>

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
