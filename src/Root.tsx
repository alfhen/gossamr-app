import { isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useEffect, useRef, useState } from "react";
import App from "./App";
import { isWorkspaceUi, useWorkspaceUi } from "./workspace/prefs";
import { Workspace } from "./workspace/Workspace";
import { auth, type AuthStatus } from "./backend/auth";
import { JiraBackend } from "./backend/jira";
import { MockBackend } from "./backend/mock";
import { announceSignedOut, onSignedOut } from "./accountEvents";
import { resetAccountState } from "./accountState";
import type { Backend } from "./backend/types";
import { listenToClaude, watchProposals } from "./claudeStore";
import { Setup } from "./components/Setup";
import { useStore } from "./store";

type Phase =
  | { name: "loading" }
  | { name: "setup"; status: AuthStatus }
  | { name: "app"; backend: Backend }
  | { name: "error"; message: string };

const accountKey = (account: { site: { cloudId: string }; me: { accountId: string } } | null) =>
  account ? `jira:${account.site.cloudId}:${account.me.accountId}` : "mock";

export function Root() {
  const workspaceUi = useWorkspaceUi();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const starts = useRef(0);
  const starting = useRef(false);
  const current = useRef<{ status: AuthStatus | null; backend: Backend | null }>({ status: null, backend: null });

  const start = (status: AuthStatus | null) => {
    const mine = ++starts.current;
    const account = status?.site && status.me ? { site: status.site, me: status.me } : null;
    resetAccountState(accountKey(account));
    current.current.backend?.dispose?.();
    starting.current = true;
    useStore.setState({ account });
    starting.current = false;
    const backend: Backend = account ? new JiraBackend({ cloudId: account.site.cloudId, accountId: account.me.accountId }) : new MockBackend();
    current.current = { status, backend };
    if (account) void askForNotifications();
    if (isWorkspaceUi()) return setPhase({ name: "app", backend });

    setPhase({ name: "loading" });
    useStore
      .getState()
      .init(backend)
      .then(
        () => {
          if (mine !== starts.current) return;
          watchProposals(backend);
          listenToClaude();
          setPhase({ name: "app", backend });
        },
        (e) => mine === starts.current && setPhase({ name: "error", message: `Couldn't load your inbox: ${e}` }),
      );
  };

  const checkAuth = () => {
    setPhase({ name: "loading" });
    auth
      .status()
      .then((s) => (s.site ? start(s) : setPhase({ name: "setup", status: s })))
      .catch((e) => setPhase({ name: "error", message: `Couldn't check your Jira sign-in: ${e}` }));
  };

  const signedOut = () => {
    starts.current++;
    current.current.backend?.dispose?.();
    current.current = { status: null, backend: null };
    resetAccountState(null);
    checkAuth();
  };

  useEffect(() => {
    if (!isTauri()) return start(null);
    checkAuth();
  }, []);

  const shown = useRef(workspaceUi);
  useEffect(() => {
    if (shown.current === workspaceUi) return;
    shown.current = workspaceUi;
    if (current.current.backend) start(current.current.status);
  }, [workspaceUi]);

  useEffect(() => onSignedOut(signedOut), []);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (prev.account && !s.account && !starting.current) announceSignedOut();
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
      return workspaceUi ? <Workspace backend={phase.backend} /> : <App />;
  }
}

async function askForNotifications() {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // The inbox works without notifications; the user can enable them later in System Settings.
  }
}
