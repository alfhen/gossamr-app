import type { ViewMode } from "./tabsStore";

export interface FooterHint {
  id: string;
  /** Lower numbers stay visible longer as the canvas narrows. */
  rank: number;
  keys: string[];
  text: string;
}

const LEAD: Partial<Record<ViewMode, FooterHint>> = {
  board: { id: "drag", rank: 2, keys: [], text: "Drag a card to draft a status change." },
  map: { id: "zoom", rank: 2, keys: [], text: "Scroll to zoom, drag to pan." },
};

const COMMON: FooterHint[] = [
  { id: "move", rank: 0, keys: ["j", "k"], text: "move and peek" },
  { id: "close", rank: 1, keys: ["Esc"], text: "close" },
  { id: "jump", rank: 1, keys: ["⌘K"], text: "jump" },
  { id: "pip", rank: 3, keys: ["⌘J"], text: "Pip" },
];

/** Display order; `rank` decides which ones go first when the footer runs out of room. */
export function footerHints(view: ViewMode): FooterHint[] {
  const lead = LEAD[view];
  const [move, close, jump, pip] = COMMON;
  return [...(lead ? [lead] : []), move, close, pip, jump];
}

/** Container-query classes that drop a hint once the footer is narrower than its rank allows. */
export const RANK_CLASS = ["", "hidden @md:inline", "hidden @xl:inline", "hidden @3xl:inline"] as const;
