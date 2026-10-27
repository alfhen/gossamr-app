import type { Mention } from "../lib/mentions";

/** What was typed into a draft's fields when it was skipped, so Undo brings the draft back with the edit still in them. */
export interface KeptEdits {
  body?: { text: string; mentions: Mention[] };
  rewrite?: { title: string; text: string };
  /** Which proposed subtasks were still ticked, when any was unticked. */
  picked?: boolean[];
}

/** The kept edits by draft id. Its own module, with no store in it, so the workspace store can read what a skipped draft said as edited. */
export const keptEdits = new Map<string, KeptEdits>();

/** The edits kept for draft `id`, if any. They stay while the draft can still be shown, so leaving a restored card before posting it doesn't lose them. */
export function keptEditsOfDraft(id: string): KeptEdits | undefined {
  return keptEdits.get(id);
}
