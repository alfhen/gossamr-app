import type { Person, Status } from "../types";

export interface Waiting {
  reason: "question" | "review" | "unstarted";
  who: Person | null;
  since: string;
}

/** A wait as its largest whole unit, such as "40m", "5h" or "12d". */
export function age(since: string, now: Date): string {
  const m = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export type StatusTone = "todo" | "progress" | "review" | "blocked" | "done";

/** Jira only exposes three status categories, so review and blocked states are recognised by name. */
export function statusTone(status: Status): StatusTone {
  if (status.category === "done") return "done";
  const name = status.name.toLowerCase();
  if (/block|hold|waiting/.test(name)) return "blocked";
  if (/review|qa|test/.test(name)) return "review";
  return status.category === "new" ? "todo" : "progress";
}

export function relativeTime(iso: string, now: Date): string {
  const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yday";
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
