import { useState, type FocusEvent, type KeyboardEvent } from "react";
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
 * The one key model (`keyMap.ts`) on a full draft card, the kind Activity's Drafts, the ticket peek and Needs you's decision
 * pane show: the card takes focus, j and k move to the card before or after it, a approves after Enter, e edits, d and s skip
 * (with Undo), Enter and o open. Returns the props for the card's element and the line it shows about its keys while it has the keyboard.
 */
export function useCardKeys(p: Proposal, acts: CardKeyActs) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [focused, setFocused] = useState(false);
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
      setFocused(false);
      setAsking(null);
    },
    onKeyDown(ev: KeyboardEvent<HTMLElement>) {
      if (ev.defaultPrevented) return;
      if (stepDraftCards(ev, ev.currentTarget.closest(SCOPE) ?? document)) return;
      onDraftCardKey(ev, p, asking, { approve: acts.approve, skip: acts.skip, edit: acts.edit, open: acts.open, primary: acts.primary, ask: setAsking, canApprove });
    },
  };
  return { props, asking, hint: focused && p.state.type === "pending" ? draftKeyHint(p, asking, canApprove) : null };
}
