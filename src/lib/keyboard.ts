export type Command =
  | "next"
  | "prev"
  | "expand"
  | "collapse"
  | "transition"
  | "snooze"
  | "done"
  | "toggleUnread"
  | "comment"
  | "open"
  | "palette"
  | "claude"
  | "help"
  | "escape";

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  typing: boolean;
}

const PLAIN: Record<string, Command> = {
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  ArrowRight: "expand",
  ArrowLeft: "collapse",
  t: "transition",
  s: "snooze",
  e: "done",
  u: "toggleUnread",
  c: "comment",
  o: "open",
  "?": "help",
};

export function commandFor(ev: KeyInput): Command | null {
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.key.toLowerCase() === "k") return "palette";
  if (mod && ev.key.toLowerCase() === "j") return "claude";
  if (ev.key === "Escape") return "escape";
  if (ev.typing || mod || ev.altKey) return null;
  return PLAIN[ev.key] ?? null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous item"],
  ["→ / ←", "Expand / collapse a ticket's updates"],
  ["t", "Transition"],
  ["s", "Snooze"],
  ["e", "Clear from Inbox"],
  ["u", "Toggle unread"],
  ["c", "Comment"],
  ["o", "Open in Jira"],
  ["⌘K", "Search tickets and actions"],
  ["⌘J", "Ask Claude about this ticket"],
  ["⌘↵", "Send comment"],
  ["Esc", "Close"],
];
