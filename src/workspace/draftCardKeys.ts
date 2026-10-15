import { useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { Proposal } from "../types";
import { draftKeyHint, draftKeyShortcuts, onDraftCardKey, stepDraftCards, type Asking } from "./draftKeys";

/**
 * Where a full draft card looks for the cards j and k step between: the list it is in (Activity's Drafts), the ticket's
 * peek, or Needs you's decision pane. Anywhere else, every card on the page.
 */
const SCOPE = "ul[aria-label], #peek-sheet, [data-needs-pane]";

/** What the keys of a full card do; each is left out where the card can't do it now, as a disabled button can't. */
export interface CardKeyActs {
  /** Approves (posts, sends, creates): asked for Enter first, as on every card. */
  approve?(): void;
  /** Skips at once and offers Undo. */
  skip?(): void;
  /** The card's own editing, where it has any inline. */
  edit?(): void;
  /** Enter and o: shows the draft where it lives, or goes to the card's main button. */
  open?(): void;
  /** a on a draft that is approved only once read: goes to the card's main button, which the person then presses. */
  primary?(): void;
  /** Whether a GitHub review may be posted from here (the token can). */
  canApprove?: boolean;
}

/**
 * Runs `after` once the press that began now is over (pointerup or pointercancel) and the click it makes has been dispatched,
 * which follows in the same task: a timer queued then runs after it.
 */
export function holdWhilePressed(win: Pick<Window, "addEventListener" | "removeEventListener">, after: () => void, defer: (run: () => void) => unknown = (run) => setTimeout(run, 0)) {
  const done = () => {
    win.removeEventListener("pointerup", done, true);
    win.removeEventListener("pointercancel", done, true);
    defer(after);
  };
  win.addEventListener("pointerup", done, true);
  win.addEventListener("pointercancel", done, true);
}

/** What Esc in a card's text field is while the posting pause shows: whether it leaves the editor and takes the pause with it (G14). */
export const escLeavesPause = (ev: { key: string; defaultPrevented: boolean; target: { tagName?: string; type?: string } | null }, paused: boolean, editing: boolean): boolean =>
  paused && editing && ev.key === "Escape" && !ev.defaultPrevented && (ev.target?.tagName === "TEXTAREA" || (ev.target?.tagName === "INPUT" && (ev.target.type === "text" || !ev.target.type)));

/**
 * The one key model (`keyMap.ts`) on a full draft card, the kind Activity's Drafts, the ticket peek and Needs you's decision
 * pane show: the card takes focus, j and k move to the card before or after it, a approves after Enter, e edits, d and s skip
 * (with Undo), Enter and o open. Returns the props for the card's element and the line it shows about its keys while it has the keyboard.
 */
export function useCardKeys(p: Proposal, acts: CardKeyActs) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [focused, setFocused] = useState(false);
  // A press on one of the card's buttons moves focus off the card and would take its key line away mid-click, shifting the buttons
  // up from under the pointer so that the click lands beside them: the line stays until the press is over.
  const pressing = useRef(false);
  const canApprove = acts.canApprove ?? p.intent.type !== "githubReview";
  const props = {
    tabIndex: 0,
    "aria-keyshortcuts": draftKeyShortcuts(p),
    "data-state": p.state.type,
    // While an approval waits for Enter, Esc is the card's: it cancels it and closes nothing else.
    "data-esc-local": asking ? "" : undefined,
    onFocus(ev: FocusEvent<HTMLElement>) {
      if (ev.target === ev.currentTarget) setFocused(true);
    },
    onBlur(ev: FocusEvent<HTMLElement>) {
      if (ev.target !== ev.currentTarget) return;
      if (!pressing.current) setFocused(false);
      setAsking(null);
    },
    onPointerDownCapture(ev: PointerEvent<HTMLElement>) {
      const card = ev.currentTarget;
      pressing.current = true;
      holdWhilePressed(window, () => {
        pressing.current = false;
        if (card.isConnected && document.activeElement !== card) setFocused(false);
      });
    },
    onKeyDown(ev: KeyboardEvent<HTMLElement>) {
      if (ev.defaultPrevented) return;
      if (stepDraftCards(ev, ev.currentTarget.closest(SCOPE) ?? document)) return;
      onDraftCardKey(ev, p, asking, { approve: acts.approve, skip: acts.skip, edit: acts.edit, open: acts.open, primary: acts.primary, ask: setAsking, canApprove });
    },
  };
  return { props, asking, hint: focused && p.state.type === "pending" ? draftKeyHint(p, asking, canApprove) : null };
}
