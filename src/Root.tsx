import { isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useEffect, useRef, useState } from "react";
import App from "./App";
import { useWorkspaceUi } from "./workspace/prefs";
import { Workspace } from "./workspace/Workspace";
import { auth, type AuthStatus } from "./backend/auth";
import { JiraBackend } from "./backend/jira";
import { MockBackend } from "./backend/mock";
import { listenToClaude, useClaude, watchProposals } from "./claudeStore";
import { Setup } from "./components/Setup";
import { useStore } from "./store";

type Phase = { name: "loading" } | { name: "setup"; status: AuthStatus } | { name: "app" } | { name: "error"; message: string };

export function Root() {
  const workspaceUi = useWorkspaceUi();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const starts = useRef(0);

  const start = (status: AuthStatus | null) => {
    // Conversations and their proposals belong to the account they were made in.
    useClaude.setState({ open: false, byTicket: {}, proposals: [] });
    const mine = ++starts.current;
    const account = status?.site && status.me ? { site: status.site, me: status.me } : null;
    useStore.setState({ account });
    setPhase({ name: "loading" });
    useStore
      .getState()
      .init(account ? new JiraBackend({ cloudId: account.site.cloudId, accountId: account.me.accountId }) : new MockBackend())
      .then(
        () => {
          if (mine !== starts.current) return;
          const backend = useStore.getState().backend;
          if (backend) watchProposals(backend);
          setPhase({ name: "app" });
        },
        (e) => mine === starts.current && setPhase({ name: "error", message: `Couldn't load your inbox: ${e}` }),
      );
    if (account) {
      void askForNotifications();
      listenToClaude();
    }
  };

  const checkAuth = () => {
    setPhase({ name: "loading" });
    auth
      .status()
      .then((s) => (s.site ? start(s) : setPhase({ name: "setup", status: s })))
      .catch((e) => setPhase({ name: "error", message: `Couldn't check your Jira sign-in: ${e}` }));
  };

  useEffect(() => {
    if (!isTauri()) return start(null);
    checkAuth();
  }, []);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (prev.account && !s.account) checkAuth();
      }),
    [],
  );

  switch (phase.name) {
    case "loading":
      return <div className="grid h-full place-items-center bg-win text-ink-3">Loading…</div>;
    case "error":
      return (
        <div className="grid h-full place-items-center bg-win px-6">
          <div className="grid max-w-[480px] gap-3 text-center">
            <p className="selectable text-blocked">{phase.message}</p>
            <div className="flex justify-center gap-3">
              <button type="button" className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white" onClick={checkAuth}>
                Try again
              </button>
              <button type="button" className="text-accent" onClick={() => start(null)}>
                Use sample data
              </button>
            </div>
          </div>
        </div>
      );
    case "setup":
      return <Setup status={phase.status} onSignedIn={start} onUseSampleData={() => start(null)} />;
    case "app":
      return workspaceUi ? <Workspace /> : <App />;
  }
}

async function askForNotifications() {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // The inbox works without notifications; the user can enable them later in System Settings.
  }
}
