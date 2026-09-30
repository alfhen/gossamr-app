import { useMemo } from "react";
import { itemKey } from "../lib/filter";
import type { StatusDef, WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useActivity } from "./activityStore";
import { AGE_TEXT, ageLevel, initials, statusTone, unreadItems, type StatusTone } from "./canvasShared";

const PILL: Record<StatusTone, string> = {
  todo: "bg-ws-sel text-ws-ink2",
  active: "bg-ws-accent-soft text-ws-accent",
  done: "bg-ws-done-soft text-ws-done",
  review: "bg-ws-review-soft text-ws-review",
  blocked: "bg-ws-blocked-soft text-ws-blocked",
};

export function StatusPill({ status, title }: { status: StatusDef; title?: string }) {
  return <span title={title} className={`inline-block max-w-full truncate rounded-full px-2 py-px text-xs font-semibold ${PILL[statusTone(status)]}`}>{status.name}</span>;
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
  const label = needsMe ? "Needs you" : "Unread updates";
  return <span role="img" aria-label={label} title={label} className={`size-1.5 flex-none rounded-full ${needsMe ? "bg-ws-pip" : "bg-ws-accent"}`} />;
}

export function NeedsPill() {
  return <span className="rounded-full bg-ws-pip-soft px-2 py-px text-xs font-semibold text-ws-pip">Needs you</span>;
}

/** Which items need the person and which have unread updates, for the dots on every canvas. */
export function useAttention() {
  const needsMe = useWorkspace((s) => s.needsMe);
  const entries = useActivity((s) => s.entries);
  const unread = useMemo(() => unreadItems(entries), [entries]);
  return { needsMe, unread, marks: (i: WorkItem) => ({ needsMe: needsMe.has(itemKey(i.item)), unread: unread.has(itemKey(i.item)) }) };
}
