import { useState } from "react";
import type { Run } from "../types";
import { Box, Btn, Sec } from "./AgentSheet";
import { useRuns } from "./runsStore";

export interface RunCleanupViewProps {
  run: Pick<Run, "worktreeRemovedAt">;
  reason: string | null;
  asking: boolean;
  busy: boolean;
  /** Claude's own words when it refused. */
  refused: string | null;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}

export function RunCleanupView({ run, reason, asking, busy, refused, onAsk, onCancel, onConfirm }: RunCleanupViewProps) {
  if (run.worktreeRemovedAt) {
    return (
      <Sec title="Clean up">
        <p className="m-0 text-ws-ink2">The worktree and its branch were removed. The result above is kept.</p>
      </Sec>
    );
  }
  if (!reason && !refused) return null;
  return (
    <Sec title="Clean up">
      <Box>
        {reason && <p className="m-0 text-ws-ink">{reason}</p>}
        <p className="m-0 text-sm text-ws-ink2">Removes this agent&apos;s worktree and branch with claude rm. Claude refuses to remove work that was never pushed, and says why. Gossamr never forces it. The result stays here.</p>
        {refused && (
          <p role="alert" data-tone="error" className="selectable m-0 text-ws-danger [overflow-wrap:anywhere] whitespace-pre-wrap">
            Claude kept it: {refused}
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
  return <RunCleanupView run={run} reason={reason} asking={asking} busy={busy} refused={refused} onAsk={() => setAsking(true)} onCancel={() => setAsking(false)} onConfirm={() => void confirm()} />;
}
