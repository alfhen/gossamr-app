import { keyIntent } from "./keyMap";
import type { NeedKey } from "./needsActions";

/** What a key does on a run's card or row in the Agents list. */
export type AgentKey = { type: "open" } | { type: "act"; act: NeedKey } | { type: "confirm" } | { type: "cancel" };

interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The one key model (`keyMap.ts`) on the Agents list, with the keyboard on a run's card or row (`onCard`; a key pressed on a
 * button inside it is that button's): o opens the run (Enter does, from the card itself); a, d, s and e do to the run what
 * they do to its row in Needs you (`needsActions.keyPlan`), so a run that isn't in Needs you has nothing for them. While one
 * of them waits for Enter (`asking`), Enter does it and any other key only cancels it, as everywhere. j, k and Esc stay the list's own.
 */
export function agentKey(ev: KeyLike, onCard: boolean, asking: boolean): AgentKey | null {
  if (!onCard || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  if (asking) return ev.key === "Enter" ? { type: "confirm" } : { type: "cancel" };
  switch (keyIntent(ev)) {
    case "open":
      return { type: "open" };
    case "approve":
      return { type: "act", act: "approve" };
    case "dismiss":
      return { type: "act", act: "dismiss" };
    case "skip":
      return { type: "act", act: "skip" };
    case "edit":
      return { type: "act", act: "edit" };
    default:
      return null;
  }
}
