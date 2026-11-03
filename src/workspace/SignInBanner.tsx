import { useMemo } from "react";
import { Button } from "../components/Button";
import type { ConnectionInfo, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { isSignedOut } from "./connectionsLogic";
import { useConnectionsUi } from "./connectionsUi";
import { isJira } from "./domains";
import { useJiraUi } from "./jiraUi";
import { instanceOf } from "./runInstance";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";

type Lost = Pick<ConnectionInfo, "id" | "kind" | "displayName" | "instanceId">;

export function SignInBanner() {
  const connections = useWorkspace((s) => s.connections);
  const runs = useRuns((s) => s.runs);
  const lost = useMemo(() => connections.filter(isSignedOut), [connections]);
  const waiting = useMemo(() => loginsWithWaitingRuns(connections, runs), [connections, runs]);
  return (
    <>
      <SignInBannerView lost={lost} onFix={fixSignIn} />
      {waiting.map((w) => (
        <LoginBannerView key={w.id} login={w} onFix={() => showConnection(w)} />
      ))}
    </>
  );
}

export interface WaitingLogin extends Lost {
  signIn: string | null;
}

const waitsOnLogin = (run: Run) => run.state === "queued" || run.state === "systemBlocked" || (run.state === "failed" && !run.shortId && run.failure?.type === "notSignedIn");

/** The Claude logins that are signed out while a run needs them: a run that waits for it, or stopped on it. A signed-out login nothing needs stays quiet in Settings. */
export function loginsWithWaitingRuns(connections: readonly ConnectionInfo[], runs: readonly Run[]): WaitingLogin[] {
  return connections
    .filter((c) => c.kind === "provider" && c.driver === "claude" && c.enabled && c.status?.state === "notSignedIn")
    .filter((c) => runs.some((r) => waitsOnLogin(r) && (r.runsOn?.instanceId ?? "claude") === c.instanceId))
    .map((c) => ({ id: c.id, kind: c.kind, displayName: c.displayName, instanceId: c.instanceId, signIn: c.status?.fix ?? instanceOf(connections, c.instanceId).signIn }));
}

/** Names the signed-out login and the command that signs it in; runs on it carry on once it is. */
export function LoginBannerView({ login, onFix }: { login: WaitingLogin; onFix(): void }) {
  return (
    <div role="alert" data-login-banner className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ws-blocked/40 py-1.5 text-sm">
      <span className="min-w-0 flex-1 text-ws-ink2">
        {login.displayName} is signed out, so agents on it wait.
        {login.signIn && (
          <>
            {" "}
            Sign in with <code className="selectable font-mono">{login.signIn}</code>.
          </>
        )}
      </span>
      <Button size="sm" onClick={onFix}>
        Open connections
      </Button>
    </div>
  );
}

/** Jira's token sheet opens on the row that lost its sign-in, so a new token renews that row instead of adding an account. */
export function fixSignIn(c: Lost | null) {
  if (c && isJira(c.kind)) useJiraUi.getState().openConnect(c.instanceId);
  else showConnection(c);
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
