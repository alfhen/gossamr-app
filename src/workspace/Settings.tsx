import { isTauri } from "@tauri-apps/api/core";
import { useMemo, type ReactNode } from "react";
import { useWorkspace } from "../workspaceStore";
import { THEME_LABEL, THEMES, usePrefs } from "./prefs";

export function connectionsOf(containers: { ref: { connectionId: string } }[]): { id: string; name: string; projects: number }[] {
  const counts = new Map<string, number>();
  for (const c of containers) counts.set(c.ref.connectionId, (counts.get(c.ref.connectionId) ?? 0) + 1);
  return [...counts].map(([id, projects]) => ({ id, name: id === "mock" ? "Sample data" : id, projects }));
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
  const connections = useMemo(() => connectionsOf(Object.values(containers)), [containers]);

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
              <li key={c.id} className="flex items-center gap-2 border-b border-ws-sep py-2 last:border-b-0">
                <span className="size-2 rounded-full bg-ws-done" aria-hidden />
                <span className="font-semibold">{c.name}</span>
                <span className="ml-auto text-ws-ink3">
                  {c.projects} {c.projects === 1 ? "project" : "projects"}
                </span>
              </li>
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
