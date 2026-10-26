import type { PauseReason } from "../types";

/** What the page says about a workstream paused for `reason` (`pausedReason`); null when it isn't paused. */
export function pausedText(reason: PauseReason | null | undefined): string | null {
  if (!reason) return null;
  return reason === "ceiling" ? "Paused: Pip was woken too often today" : "Paused";
}

/** The whole banner of a paused workstream: why, and that nothing wakes Pip until the person resumes it. */
export function pausedBanner(reason: PauseReason | null | undefined): string | null {
  const text = pausedText(reason);
  return text && `${text}. Pip isn't woken until you resume it.`;
}
