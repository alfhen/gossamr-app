import { useEffect, useState, type ReactNode } from "react";
import { THEME_LABEL, THEMES, usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { syncLine } from "./connectionsLogic";
import { ConnectionsSection } from "./Connections";
import { WatchingSection } from "./WatchSettings";
import { useEscBack } from "./escBack";
import { Segmented } from "../components/Segmented";

/** The two facts the app states about what it does, and only here. */
export const PROMISES = ["Gossamr posts nothing to Jira or GitHub until you approve it.", "Agents run with your own Claude Code settings, so they can push branches and use your own tools."] as const;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-b border-ws-sep py-5">
      <h2 className="font-display m-0 mb-2.5 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Settings() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  useEscBack();
  const now = useNow();
  const section = useTabs((s) => s.settingsSection);
  useEffect(() => {
    if (!section) return;
    document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" });
    useTabs.setState({ settingsSection: null });
  }, [section]);

  return (
    <div className="h-full overflow-auto px-8 pb-10">
      <h1 className="font-display m-0 pt-6 text-xl font-bold">Settings</h1>
      <div className="max-w-[720px]">
        <Section title="Safety">
          <ul data-promises className="m-0 grid list-none gap-1.5 p-0 text-ws-ink2">
            {PROMISES.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Section>

        <Section title="Theme">
          <Segmented kind="radio" label="Theme" value={theme} onChange={setTheme} options={THEMES.map((t) => ({ value: t, label: THEME_LABEL[t] }))} />
        </Section>

        <Section title="Connections" id="settings-connections">
          <ConnectionsSection now={now} />
        </Section>

        <Section title="Watching" id="settings-watching">
          <WatchingSection syncLine={syncLine} />
        </Section>
      </div>
    </div>
  );
}
