import { useMemo } from "react";
import { itemKey, YOUR_TURN, YOUR_TURN_WHY } from "../lib/filter";
import type { StatusDef, WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useActivity } from "./activityStore";
import { AGE_TEXT, ageLevel, initials, statusTone, unreadItems, type StatusTone } from "./canvasShared";

export const BEAD: Record<StatusTone, string> = {
  todo: "[--c:var(--color-ws-ink3)]",
  active: "[--c:var(--color-ws-accent)]",
  done: "[--c:var(--color-ws-done)]",
  review: "[--c:var(--color-ws-review)]",
  blocked: "[--c:var(--color-ws-blocked)]",
};

export function StatusPill({ status, title }: { status: StatusDef; title?: string }) {
  return (
    <span title={title} className="inline-flex max-w-full items-center gap-[7px] text-xs font-medium text-ws-ink2">
      <i aria-hidden className={`ws-bead ${BEAD[statusTone(status)]}`} />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  return (
    <span title={name} className="grid size-[22px] flex-none place-items-center rounded-full bg-ws-sel text-[10px] font-bold text-ws-ink2">
      {initials(name)}
    </span>
  );
}

/** Days quiet, coloured by how long; `ws-age` keeps it above the wither overlay. */
export function AgeChip({ days, className = "" }: { days: number; className?: string }) {
  return (
    <span className={`ws-age text-xs font-semibold ${AGE_TEXT[ageLevel(days)]} ${className}`} title={`No update for ${days} days`}>
      {days}d
    </span>
  );
}

export function AttentionDot({ needsMe, unread }: { needsMe: boolean; unread: boolean }) {
  if (!needsMe && !unread) return null;
  const label = needsMe ? YOUR_TURN : "Unread updates";
  return <span role="img" aria-label={label} title={needsMe ? YOUR_TURN_WHY : label} className={`size-1.5 flex-none rounded-full ${needsMe ? "bg-ws-pip" : "bg-ws-accent"}`} />;
}

/** The pill on a ticket, or an Activity entry, waiting on the person: Your turn, with why in its tooltip. */
export function TurnPill({ why = YOUR_TURN_WHY, className = "py-px" }: { why?: string; className?: string }) {
  return (
    <span title={why} data-your-turn className={`rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip ${className}`}>
      {YOUR_TURN}
    </span>
  );
}

/** Which items need the person and which have unread updates, for the dots on every canvas. */
export function useAttention() {
  const needsMe = useWorkspace((s) => s.needsMe);
  const entries = useActivity((s) => s.entries);
  const unread = useMemo(() => unreadItems(entries), [entries]);
  return { needsMe, unread, marks: (i: WorkItem) => ({ needsMe: needsMe.has(itemKey(i.item)), unread: unread.has(itemKey(i.item)) }) };
}
