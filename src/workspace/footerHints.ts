import { PIP_HOME_HINT } from "./commands";
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

/** Shown only while Agents are on, which is when Pip home is there. */
const PIP_HOME: FooterHint = { id: "pip-home", rank: 3, keys: [PIP_HOME_HINT], text: "Pip home" };

/** Display order; `rank` decides which ones go first when the footer runs out of room. */
export function footerHints(view: ViewMode, pipHome = false): FooterHint[] {
  const lead = LEAD[view];
  const [move, close, jump, pip] = COMMON;
  return [...(lead ? [lead] : []), move, close, pip, ...(pipHome ? [PIP_HOME] : []), jump];
}

/** Pip home's own footer: its keys, the columns first since they are what the rest of the screen hangs on. */
export function pipHomeHints(): FooterHint[] {
  return [
    { id: "columns", rank: 0, keys: ["F6", "⌘]"], text: "next column" },
    { id: "move", rank: 0, keys: ["j", "k"], text: "move" },
    { id: "open", rank: 1, keys: ["↵"], text: "open" },
    { id: "decide", rank: 2, keys: ["a", "s"], text: "approve or skip a draft" },
    { id: "start", rank: 2, keys: ["⌘↵"], text: "start" },
    { id: "close", rank: 1, keys: ["Esc"], text: "close, then stop Pip" },
    { id: "jump", rank: 3, keys: ["⌘K"], text: "jump" },
  ];
}

/** Container-query classes that drop a hint once the footer is narrower than its rank allows. */
export const RANK_CLASS = ["", "hidden @md:inline", "hidden @xl:inline", "hidden @3xl:inline"] as const;
