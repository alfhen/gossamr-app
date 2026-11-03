import { useState } from "react";
import type { Driver } from "../lib/models";
import type { Run } from "../types";
import { Box, Btn, Sec } from "./AgentSheet";
import { leftoverSessions } from "./cleanupLogic";
import { DEFAULT_INSTANCE } from "./providerLogic";
import { useRunInstance } from "./runInstance";
import { useRuns } from "./runsStore";
import { useWorkspace } from "../workspaceStore";

export interface RunCleanupViewProps {
  run: Pick<Run, "worktreeRemovedAt" | "earlierSessions" | "sessionsLeft">;
  reason: string | null;
  asking: boolean;
  busy: boolean;
  /** The name of the login the run was on; null once that login is removed. */
  login: string | null;
  /** What removes the worktree: `claude rm` for Claude, the tool called "git" for Codex. Claude when left out. */
  driver?: Driver;
  /** Its own words when it refused. */
  refused: string | null;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}

export function RunCleanupView({ run, reason, login, driver = "claude", asking, busy, refused, onAsk, onCancel, onConfirm }: RunCleanupViewProps) {
  if (run.worktreeRemovedAt) {
    const left = leftoverSessions(run);
    return (
      <Sec title="Clean up">
        <p className="m-0 text-ws-ink2">The worktree and its branch were removed. The result above is kept.</p>
        {run.sessionsLeft && <p className="m-0 text-ws-ink2">{`The session was left in ${login ?? "that login"}'s folder.`}</p>}
        {left > 0 && (
          <Box>
            <p className="m-0 text-ws-ink">
              {left === 1 ? "An earlier session of this run is still there." : `${left} earlier sessions of this run are still there.`}
            </p>
            {refused && (
              <p role="alert" data-tone="error" className="selectable m-0 text-ws-danger [overflow-wrap:anywhere] whitespace-pre-wrap">
                {login ?? "The login"} kept it: {refused}
              </p>
            )}
            <div>
              <Btn icon="folder" disabled={busy} onClick={onConfirm}>
                {busy ? "Removing…" : "Try removing again"}
              </Btn>
            </div>
          </Box>
        )}
      </Sec>
    );
  }
  if (!reason && !refused) return null;
  return (
    <Sec title="Clean up">
      <Box>
        {reason && <p className="m-0 text-ws-ink">{reason}</p>}
        <p className="m-0 text-sm text-ws-ink2">
          {driver === "codex"
            ? "Removes this agent's worktree and branch with git. Git refuses to remove changes or a branch that isn't merged, and says why. Gossamr never forces it. The result stays here."
            : "Removes this agent's worktree and branch with claude rm. Claude refuses to remove work that was never pushed, and says why. Gossamr never forces it. The result stays here."}
        </p>
        {refused && (
          <p role="alert" data-tone="error" className="selectable m-0 text-ws-danger [overflow-wrap:anywhere] whitespace-pre-wrap">
            {login ?? "The login"} kept it: {refused}
          </p>
        )}
        {asking ? (
          <div role="group" aria-label="Clean up this run" data-esc-local className="flex flex-wrap items-center gap-2" onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), onCancel())}>
            <span className="text-ws-ink2">Remove the worktree?</span>
            <Btn tone="dangerFill" autoFocus disabled={busy} onClick={onConfirm}>
              {busy ? "Removing…" : "Yes, remove it"}
            </Btn>
            <Btn tone="ghost" disabled={busy} onClick={onCancel}>
              Keep it
            </Btn>
          </div>
        ) : (
          <div>
            <Btn icon="folder" onClick={onAsk}>
              Clean up
            </Btn>
          </div>
        )}
      </Box>
    </Sec>
  );
}

export function RunCleanup({ run, reason }: { run: Run; reason: string | null }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    const result = await useRuns.getState().cleanup(run.id);
    setBusy(false);
    setAsking(false);
    setRefused(result?.type === "refused" ? result.message : null);
  };
  const instance = useRunInstance(run);
  const instanceId = run.runsOn?.instanceId ?? DEFAULT_INSTANCE;
  const known = useWorkspace((s) => s.connections.some((c) => c.kind === "provider" && c.instanceId === instanceId));
  const login = known ? instance.name : null;
  return <RunCleanupView run={run} reason={reason} login={login} driver={instance.driver} asking={asking} busy={busy} refused={refused} onAsk={() => setAsking(true)} onCancel={() => setAsking(false)} onConfirm={() => void confirm()} />;
}
