import type { Intent, Run } from "../types";

export type FollowUpIntent = Extract<Intent, { type: "followUp" }>;

/** The most a follow-up message may hold, as in the backend. */
export const FOLLOW_UP_LIMIT = 4000;

/** The run a follow-up is for, as people name it elsewhere: the session id, or a prefix of the run id when none is known. */
export const followUpRunLabel = (i: FollowUpIntent) => i.shortId ?? i.runId.slice(0, 8);

export const followUpTitle = (i: FollowUpIntent) => `Follow-up for run ${followUpRunLabel(i)}`;

/** The pass the agent would be on once this is sent: the run's count, one higher. */
export const nextPass = (run: Pick<Run, "passes"> | null | undefined) => (run?.passes ?? 1) + 1;

export const followUpProblem = (message: string) => (!message.trim() ? "Write the message to send first." : message.length > FOLLOW_UP_LIMIT ? `A follow-up can be up to ${FOLLOW_UP_LIMIT} characters.` : null);

/** Why a run can't be sent back, in the backend's words, or null when it can: it has finished (or stopped at a limit) and has a session. */
export function followUpBlocker(run: Run): string | null {
  const atRest = run.state === "done" || (run.state === "stopped" && !!run.stoppedByLimit && !run.unsentAnswer);
  if (!atRest) {
    if (run.state === "needsAnswer" || run.state === "needsPermission" || run.state === "systemBlocked") return "it is waiting on the person, who answers it themselves";
    if (run.state === "stopped" && run.unsentAnswer) return "an answer of the person's is still waiting to be sent to it";
    return `it is ${run.state}, so it hasn't finished`;
  }
  return run.shortId && run.sessionId ? null : "it has no session to resume";
}
