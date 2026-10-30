import { isTauri } from "@tauri-apps/api/core";
import { Button } from "./components/Button";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useEffect, useState } from "react";
import { Workspace } from "./workspace/Workspace";
import { auth, type AuthStatus } from "./backend/auth";
import { JiraBackend } from "./backend/jira";
import { MockBackend } from "./backend/mock";
import { mockOptionsFromUrl } from "./backend/mockWatch";
import { onSignedOut } from "./accountEvents";
import { resetAccountState } from "./accountState";
import type { Backend } from "./backend/types";
import { Setup } from "./components/Setup";

type Phase =
  | { name: "loading" }
  | { name: "setup"; status: AuthStatus }
  | { name: "app"; backend: Backend }
  | { name: "error"; message: string };

const accountKey = (account: { site: { cloudId: string }; me: { accountId: string } } | null) =>
  account ? `jira:${account.site.cloudId}:${account.me.accountId}` : "mock";

export function Root() {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  const start = (status: AuthStatus | null) => {
    const account = status?.site && status.me ? { site: status.site, me: status.me } : null;
    resetAccountState(accountKey(account));
    const backend: Backend = account ? new JiraBackend() : new MockBackend(mockOptionsFromUrl());
    if (account) void askForNotifications();
    setPhase({ name: "app", backend });
  };

  const checkAuth = () => {
    setPhase({ name: "loading" });
    auth
      .status()
      .then((s) => (s.site ? start(s) : setPhase({ name: "setup", status: s })))
      .catch((e) => setPhase({ name: "error", message: `Couldn't check your Jira sign-in: ${e}` }));
  };

  const signedOut = () => {
    resetAccountState(null);
    checkAuth();
  };

  useEffect(() => {
    if (!isTauri()) return start(null);
    checkAuth();
  }, []);

  useEffect(() => onSignedOut(signedOut), []);

  switch (phase.name) {
    case "loading":
      return <div className="grid h-full place-items-center bg-win text-ink-3">Loading…</div>;
    case "error":
      return (
        <div className="grid h-full place-items-center bg-win px-6">
          <div className="grid max-w-[480px] gap-3 text-center">
            <p className="selectable text-blocked">{phase.message}</p>
            <div className="flex justify-center gap-3">
              <Button variant="primary" onClick={checkAuth}>
                Try again
              </Button>
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
      return <Workspace backend={phase.backend} />;
  }
}

async function askForNotifications() {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // The inbox works without notifications; the user can enable them later in System Settings.
  }
}
