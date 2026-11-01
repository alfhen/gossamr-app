import { useMemo } from "react";
import { Button } from "../components/Button";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { isSignedOut } from "./connectionsLogic";
import { useConnectionsUi } from "./connectionsUi";
import { isJira } from "./domains";
import { useJiraUi } from "./jiraUi";
import { useTabs } from "./tabsStore";

type Lost = Pick<ConnectionInfo, "id" | "kind" | "displayName">;

export function SignInBanner() {
  const connections = useWorkspace((s) => s.connections);
  const lost = useMemo(() => connections.filter(isSignedOut), [connections]);
  return <SignInBannerView lost={lost} onFix={(c) => (c && isJira(c.kind) ? useJiraUi.getState().openConnect() : showConnection(c))} />;
}

function showConnection(c: Lost | null) {
  if (c) useConnectionsUi.getState().select(c.id);
  useTabs.getState().openSettings("connections");
}

/** One banner for any connection that is on and signed out. Jira's button goes straight to the token sheet; the rest open their detail. */
export function SignInBannerView({ lost, onFix }: { lost: Lost[]; onFix(only: Lost | null): void }) {
  if (!lost.length) return null;
  const only = lost.length === 1 ? lost[0] : null;
  const jira = only !== null && isJira(only.kind);
  const text = !only ? `${lost.length} connections are signed out, so they aren't syncing.` : jira ? "Jira turned down your token, so Jira isn't syncing. Your drafts, runs and proposals are kept." : `${only.displayName} is signed out, so it isn't syncing.`;
  return (
    <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ws-blocked/40 py-1.5 text-sm">
      <span className="min-w-0 flex-1 text-ws-ink2">{text}</span>
      <Button size="sm" onClick={() => onFix(only)}>
        {jira ? "Make a new token" : "Open connections"}
      </Button>
    </div>
  );
}
