import type { Proposal } from "../types";
import { keyIntent } from "./keyMap";

/** What a key pressed on a focused draft card does. `edit` opens the card's editing where it has its own (the full card), else what `open` does. */
export type DraftKeyAction = "approve" | "skip" | "open" | "edit";

/** A draft card in the conversation, as the keyboard finds it. */
export const DRAFT_CARD = "article[data-draft]";

/**
 * Drafts the card may approve in place. A rewrite is approved after its diff is read, so it only opens.
 */
const INLINE: ReadonlySet<Proposal["intent"]["type"]> = new Set(["comment", "transition", "subtasks", "create", "link", "update"]);

/** Drafts with something to edit: a transition or a link is only approved or skipped, and says nothing to change. */
const EDITABLE: ReadonlySet<Proposal["intent"]["type"]> = new Set(["comment", "rewrite", "subtasks", "create", "githubReview"]);

/**
 * The one key model (`keyMap.ts`) on a draft: Enter and o open; a approves where the card can, or opens where approving
 * needs a review first; e edits (opens the review where editing happens, on a draft that has something to edit); d and s
 * skip, which acts at once and offers Undo. A decided draft only opens. A GitHub review is posted in place only when the
 * card knows the token may post it (`canApprove`); otherwise a opens, where the card says why it can't be posted.
 */
export function draftKeyAction(p: Proposal, key: string, canApprove = false): DraftKeyAction | null {
  const intent = keyIntent({ key });
  if (intent === "open") return "open";
  if (p.state.type !== "pending") return null;
  switch (intent) {
    case "approve":
      return INLINE.has(p.intent.type) || (p.intent.type === "githubReview" && canApprove) ? "approve" : "open";
    case "edit":
      return EDITABLE.has(p.intent.type) ? "edit" : null;
    case "dismiss":
    case "skip":
      return "skip";
    default:
      return null;
  }
}

/** The one decision a card waits for Enter to confirm: approving, which posts or writes. Skipping acts at once. */
export type Asking = "approve";

/**
 * The one line a focused card shows about its keys, or what it asks while the approval waits to be confirmed. `canApprove`
 * false leaves a out, for a review the token can't post; true lets a review be posted. A review is posted rather than
 * approved. The words are the model's (`keyMap.ts`).
 */
export function draftKeyHint(p: Proposal, asking: Asking | null = null, canApprove = p.intent.type !== "githubReview", openHint = "open"): string {
  const review = p.intent.type === "githubReview";
  if (asking) return `↵ ${review ? "post this review" : "approve"} · any other key cancels`;
  const keys: string[] = [];
  if (canApprove && draftKeyAction(p, "a", canApprove) === "approve") keys.push(review ? "a post" : "a approve");
  if (draftKeyAction(p, "e")) keys.push("e edit");
  if (draftKeyAction(p, "s")) keys.push("d s skip");
  keys.push(`↵ ${openHint}`);
  return keys.join(" · ");
}

/** The card's aria-keyshortcuts. */
export function draftKeyShortcuts(p: Proposal): string {
  return draftKeyAction(p, "s") ? `a${draftKeyAction(p, "e") ? " e" : ""} d s Enter o` : "Enter o";
}

/** The id of Pip's message input, where a card sends typing that isn't one of its keys. */
export const PIP_INPUT_ID = "pip-input";

/** What holds one conversation with Pip, its cards and its composer: the Pip pane. */
export const PIP_ROOT = "[data-pip-root]";

interface KeyEventLike {
  key: string;
  target: unknown;
  currentTarget: unknown;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  preventDefault(): void;
  /** React's: whether a handler nearer the target already took the key. */
  isDefaultPrevented?(): boolean;
}

interface Focusable {
  focus(): void;
  scrollIntoView?(arg?: ScrollIntoViewOptions): void;
  getAttribute(name: string): string | null;
  setAttribute?(name: string, value: string): void;
}

interface CardRoot {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

/** The draft cards under `root` the keyboard can reach: not the whole card of a retired draft folded away under its one line. */
const reachableCards = (root: CardRoot) => (Array.from(root.querySelectorAll(DRAFT_CARD)) as (Focusable & { closest?(s: string): unknown })[]).filter((c) => !c.closest?.("[hidden]"));

const plain = (ev: Pick<KeyEventLike, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) => !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;

const isCard = (t: unknown): t is Focusable => !!t && typeof (t as { matches?: unknown }).matches === "function" && (t as Element).matches(DRAFT_CARD);

const show = (card: Focusable) => {
  card.focus();
  card.scrollIntoView?.({ block: "nearest" });
};

/** Marks a card that ArrowUp from the empty input just reached; the card clears it on its first key or when it loses focus. */
export const FROM_INPUT = "data-from-input";

/**
 * The card's keys that only cancel while an approval waits for Enter: the ones that decide or open (a, s, o, Enter, Esc). d and
 * e are letters a new question starts with ("add", "explain"), so after a they go back to the input with it, as before.
 */
const CARD_KEYS = new Set(["a", "s", "o", "Enter", "Escape"]);

/** The keys that act on a card just reached from the empty input instead of going back to it as typing: approving asks for Enter, skipping can be undone. */
const ACTS_FROM_INPUT = new Set(["a", "d", "s"]);

/**
 * Whether Esc on a card whose review is open under it, or inside that review, hides the review: a plain Esc while no
 * decision waits for Enter (one that does keeps Esc for cancelling itself).
 */
export function escapeCollapses(ev: Pick<KeyEventLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, asking: Asking | null): boolean {
  return ev.key === "Escape" && !asking && plain(ev);
}

/** Letters the conversation steps between cards with; they are never typing. */
const STEPS = new Set(["j", "k"]);

/** How long a press of e on a compact card waits for the full card to mount, which a peek opening can take a few frames to do. */
const EDIT_INTENT_MS = 3000;
let editIntent: { id: string; at: number } | null = null;
/** e on a compact card: the full card of draft `id`, once it shows, starts in its editing. */
export const setDraftEditIntent = (id: string, now = Date.now()) => void (editIntent = { id, at: now });
/** Whether draft `id`'s card was opened for editing: once, so a card shown later is not. */
export function takeDraftEditIntent(id: string, now = Date.now()): boolean {
  const was = editIntent;
  if (!was || was.id !== id || now - was.at > EDIT_INTENT_MS) return false;
  // Let go once the current task is over: a mount effect that runs twice in a row (React's development check) reads it twice.
  queueMicrotask(() => void (editIntent === was && (editIntent = null)));
  return true;
}

interface CardActs {
  approve?(): void;
  /** Skips at once and offers Undo; there is nothing to confirm. */
  skip?(): void;
  /** e: the card's own editing; a card with none opens, as Enter does. */
  edit?(): void;
  /** Enter and o; a card with nothing to open leaves them alone. */
  open?(): void;
  /** a on a draft that needs reading first: the card's main button, where a card has one to go to; else what `open` does. */
  primary?(): void;
  /** Sets or clears the approval waiting for Enter. */
  ask(asking: Asking | null): void;
  /** Takes text the person was typing back to the input; false when there is no input to take it. */
  type?(text: string): boolean;
  /** The card was reached by ArrowUp from the empty input and this is its first key. */
  fromInput?: boolean;
  /** Whether the card may approve a GitHub review in place, which it may only when the token can post it. */
  canApprove?: boolean;
}

/**
 * A key on the card itself, never one typed into a field or pressed on a button inside it, and never with a modifier.
 * Approving takes two keys, a and then Enter, so a person who thinks they are still typing in the input never posts or
 * writes anything: any other key cancels. Skipping (d or s) acts at once, since Undo puts the draft back. One of the card's
 * own keys only cancels a waiting approval; a letter that is not one of them goes back to the input together with the a
 * before it. Returns whether it acted.
 */
export function onDraftCardKey(ev: KeyEventLike, p: Proposal, asking: Asking | null, act: CardActs): boolean {
  if (ev.target !== ev.currentTarget || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  // Only what the draft still allows: one decided elsewhere meanwhile, or that only opens, confirms nothing.
  const still = asking && draftKeyAction(p, "a", act.canApprove) === asking;
  const confirmed = !still ? undefined : act.approve;
  if (asking) act.ask(null);
  // Just reached from the empty input, a letter is more likely the start of a new question than a card key: it goes back
  // to the input, j, k, o and e included. a, s and d keep their meaning: a asks for Enter, and a skip can be undone.
  if (act.fromInput && !asking && ev.key.length === 1 && act.type && !ACTS_FROM_INPUT.has(ev.key)) {
    if (!act.type(ev.key)) return false;
    ev.preventDefault();
    return true;
  }
  if (!ev.shiftKey) {
    if (confirmed && ev.key === "Enter") {
      ev.preventDefault();
      confirmed();
      return true;
    }
    // Any other of the card's own keys only cancels: it never goes on to ask, open or skip in turn.
    if (asking && CARD_KEYS.has(ev.key)) {
      ev.preventDefault();
      return true;
    }
    const action = draftKeyAction(p, ev.key, act.canApprove);
    if (action === "approve" && act.approve) {
      ev.preventDefault();
      act.ask("approve");
      return true;
    }
    // While an approval waits, d and e are the next letters of what the person is typing, not decisions.
    if (!asking && action === "skip" && act.skip) {
      ev.preventDefault();
      act.skip();
      return true;
    }
    if (!asking && action === "edit") {
      const go = act.edit ?? act.open;
      if (!go) return false;
      ev.preventDefault();
      go();
      return true;
    }
    // a on a draft that is approved only after it is read goes to its main button rather than opening it.
    const go = ev.key === "a" ? (act.primary ?? act.open) : act.open;
    if (action === "open" && go) {
      ev.preventDefault();
      go();
      return true;
    }
    if (STEPS.has(ev.key)) return false;
  }
  if (ev.key.length !== 1 || !act.type) return false;
  const typed = (asking === "approve" ? "a" : "") + ev.key;
  if (!act.type(typed)) return false;
  ev.preventDefault();
  return true;
}

/**
 * Where focus goes when the focused card is about to leave the conversation, as a decided draft under "Drafts waiting"
 * does: the next card, else the one before, else the input. Never nowhere, where the next j or k would move the canvas.
 */
export function focusAfterLeaving(card: unknown, root: CardRoot, input: Focusable | null, defer?: (go: () => void) => void) {
  const cards: Focusable[] = reachableCards(root);
  const at = cards.indexOf(card as Focusable);
  // A card still waiting for its decision comes first, forward then back; a decided one only when none is left.
  const pending = (c: Focusable) => c.getAttribute("data-state") === "pending";
  const next = at < 0 ? undefined : (cards.slice(at + 1).find(pending) ?? cards.slice(0, at).reverse().find(pending) ?? cards[at + 1] ?? cards[at - 1]);
  const go = () => (next ? show(next) : input?.focus());
  // Called as the card unmounts, inside React's commit, where React hears no focus event: the next card would take focus
  // but never arm, and its keys would do nothing. `defer` hands focus over once the commit is done.
  if (defer) defer(go);
  else go();
}

/** ArrowDown and j move to the next draft card in the conversation, ArrowUp and k to the previous one. Only from a focused card. */
export function stepDraftCards(ev: KeyEventLike, root: CardRoot): boolean {
  const step = ev.key === "ArrowDown" || ev.key === "j" ? 1 : ev.key === "ArrowUp" || ev.key === "k" ? -1 : 0;
  if (!step || !plain(ev) || !isCard(ev.target) || ev.isDefaultPrevented?.()) return false;
  // Taken even at either end, so j and k never fall through to stepping the canvas behind the pane.
  ev.preventDefault();
  const cards: Focusable[] = reachableCards(root);
  const next = cards[cards.indexOf(ev.target) + step];
  if (next) show(next);
  return true;
}

/** ArrowUp from an empty input goes to the newest draft still waiting, the last one in the conversation. */
export function upToNewestDraft(ev: Pick<KeyEventLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "preventDefault">, value: string, root: CardRoot): boolean {
  if (ev.key !== "ArrowUp" || value !== "" || !plain(ev)) return false;
  const cards: Focusable[] = reachableCards(root);
  const newest = cards.filter((c) => c.getAttribute("data-state") === "pending").pop();
  if (!newest) return false;
  ev.preventDefault();
  newest.setAttribute?.(FROM_INPUT, "");
  show(newest);
  return true;
}
