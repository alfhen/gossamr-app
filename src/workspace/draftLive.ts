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
}

const live = new Map<string, LiveDraft>();

/** The card for `id` reports its state; null when it is gone or decided. */
export function setLiveDraft(id: string, state: LiveDraft | null) {
  if (state) live.set(id, state);
  else live.delete(id);
}

export const liveDraft = (id: string): LiveDraft | undefined => live.get(id);
