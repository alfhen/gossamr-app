import { create } from "zustand";

/**
 * What a mounted draft card holds that the draft itself doesn't: whether the person typed into it, and whether what it would
 * post trips the posting pause. The keyboard route that approves from Needs you's list reads it, so "a, Enter" posts what the card
 * shows and pauses where the card's own Post does, instead of approving the stored text.
 */
export interface LiveDraft {
  /** The card holds an edit the draft doesn't. */
  edited: boolean;
  /** Approving now would stop at the posting pause. */
  risky: boolean;
  /** A comment's text as typed, once the card holds an edit of it: what a row or preview shows in place of the stored text. */
  text?: string;
}

const live = new Map<string, LiveDraft>();

/** Bumped whenever what a card holds changes, so a row or preview that shows "edited" follows it (the maps above are not reactive). */
const useRev = create<{ rev: number }>(() => ({ rev: 0 }));
export const touchDrafts = () => useRev.setState((s) => ({ rev: s.rev + 1 }));
/** Re-renders its component whenever a card's edit state changes. */
export const useDraftsRev = () => useRev((s) => s.rev);

/** The card for `id` reports its state; null when it is gone or decided. */
export function setLiveDraft(id: string, state: LiveDraft | null) {
  const was = live.get(id);
  if (state) live.set(id, state);
  else live.delete(id);
  if (!was !== !state || was?.edited !== state?.edited || was?.text !== state?.text) touchDrafts();
}

export const liveDraft = (id: string): LiveDraft | undefined => live.get(id);
