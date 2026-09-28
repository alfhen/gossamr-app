import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import App from "./App";
import { auth, type AuthStatus } from "./backend/auth";
import { JiraBackend } from "./backend/jira";
import { MockBackend } from "./backend/mock";
import { Setup } from "./components/Setup";
import { useStore } from "./store";

type Phase = { name: "loading" } | { name: "setup"; status: AuthStatus } | { name: "app" } | { name: "error"; message: string };

export function Root() {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  const start = (status: AuthStatus | null) => {
    const account = status?.site && status.me ? { site: status.site, me: status.me } : null;
    useStore.setState({ account });
    void useStore.getState().init(account ? new JiraBackend() : new MockBackend());
    setPhase({ name: "app" });
  };

  useEffect(() => {
    if (!isTauri()) return start(null);
    auth
      .status()
      .then((s) => (s.site ? start(s) : setPhase({ name: "setup", status: s })))
      .catch((e) => setPhase({ name: "error", message: String(e) }));
  }, []);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (prev.account && !s.account) {
          void auth.status().then((status) => setPhase({ name: "setup", status }));
        }
      }),
    [],
  );

  switch (phase.name) {
    case "loading":
      return <div className="grid h-full place-items-center bg-win text-ink-3">Loading…</div>;
    case "error":
      return <div className="selectable grid h-full place-items-center bg-win px-6 text-blocked">{phase.message}</div>;
    case "setup":
      return <Setup status={phase.status} onSignedIn={start} onUseSampleData={() => start(null)} />;
    case "app":
      return <App />;
  }
}
