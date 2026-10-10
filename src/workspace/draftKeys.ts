import type { Proposal } from "../types";

/** What a key pressed on a focused draft card in Pip's conversation does. */
export type DraftKeyAction = "approve" | "skip" | "open";

/** A draft card in the conversation, as the keyboard finds it. */
export const DRAFT_CARD = "article[data-draft]";

/**
 * Drafts the card may approve in place. A rewrite is approved after its diff is read, a run after its prompt is read and a
 * follow-up after its message is read, so those only open. An answer's card shows its whole reply, so it is sent from there.
 */
const INLINE: ReadonlySet<Proposal["intent"]["type"]> = new Set(["comment", "transition", "subtasks", "create", "link", "update", "runAnswer"]);

/**
 * Enter and o open; a approves where the card can, or opens where approving needs a review first; s skips. A decided draft
 * only opens. A GitHub review is posted in place only when the card knows the token may post it (`canApprove`); otherwise a
 * opens, where the card says why it can't be posted.
 */
export function draftKeyAction(p: Proposal, key: string, canApprove = false): DraftKeyAction | null {
  if (key === "Enter" || key === "o") return "open";
  if (p.state.type !== "pending") return null;
  if (key === "a") return INLINE.has(p.intent.type) || (p.intent.type === "githubReview" && canApprove) ? "approve" : "open";
  if (key === "s") return "skip";
  return null;
}

/** A decision a card waits for Enter to confirm. */
export type Asking = "approve" | "skip";

/**
 * The one line a focused card shows about its keys, or what it asks while a decision waits to be confirmed. `canApprove`
 * false leaves a out, for an answer whose run isn't asking any more or a review the token can't post; true lets a review
 * be posted. An answer is sent rather than approved, and a review posted.
 */
export function draftKeyHint(p: Proposal, asking: Asking | null = null, canApprove = p.intent.type !== "githubReview"): string {
  const answer = p.intent.type === "runAnswer";
  const review = p.intent.type === "githubReview";
  if (asking) return `↵ ${asking === "approve" && answer ? "send this reply" : asking === "approve" && review ? "post this review" : asking} · any other key cancels`;
  if (canApprove && draftKeyAction(p, "a", canApprove) === "approve") return answer ? "a send · s skip · ↵ open" : review ? "a post · s skip · ↵ open" : "a approve · s skip · ↵ open";
  return draftKeyAction(p, "s") ? "s skip · ↵ open" : "↵ open";
}

/** The card's aria-keyshortcuts. */
export function draftKeyShortcuts(p: Proposal): string {
  return draftKeyAction(p, "s") ? "a s Enter o" : "Enter o";
}

/** The id of Pip's message input, where a card sends typing that isn't one of its keys. */
export const PIP_INPUT_ID = "pip-input";

/** What holds one conversation with Pip, its cards and its composer: the Pip pane, or Pip home's conversation column. */
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

/** Letters the conversation steps between cards with; they are never typing. */
const STEPS = new Set(["j", "k"]);

interface CardActs {
  approve?(): void;
  skip?(): void;
  open(): void;
  /** Sets or clears the decision waiting for Enter. */
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
 * Approving and skipping take two keys, a or s and then Enter, so a person who thinks they are still typing in the input
 * never decides a draft: any other key cancels, and a letter that is not one of the card's keys goes back to the input
 * together with the a or s before it. Returns whether it acted.
 */
export function onDraftCardKey(ev: KeyEventLike, p: Proposal, asking: Asking | null, act: CardActs): boolean {
  if (ev.target !== ev.currentTarget || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  // Only what the draft still allows: one decided elsewhere meanwhile, or that only opens, confirms nothing.
  const still = asking && draftKeyAction(p, asking === "approve" ? "a" : "s", act.canApprove) === asking;
  const confirmed = !still ? undefined : asking === "approve" ? act.approve : act.skip;
  if (asking) act.ask(null);
  // Just reached from the empty input, a letter is more likely the start of a new question than a card key: it goes back
  // to the input, j, k and o included. a and s keep their meaning, which never writes on one key: they ask for Enter on a
  // decision, and the letter after them goes back too; on a run draft a opens its setup, which starts nothing.
  if (act.fromInput && !asking && ev.key.length === 1 && act.type && ev.key !== "a" && ev.key !== "s") {
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
    if (asking && ev.key === "Escape") {
      ev.preventDefault();
      return true;
    }
    const action = draftKeyAction(p, ev.key, act.canApprove);
    const decide = action === "approve" ? act.approve : action === "skip" ? act.skip : undefined;
    if (decide && (action === "approve" || action === "skip")) {
      ev.preventDefault();
      act.ask(action);
      return true;
    }
    if (action === "open") {
      ev.preventDefault();
      act.open();
      return true;
    }
    if (STEPS.has(ev.key)) return false;
  }
  if (ev.key.length !== 1 || !act.type) return false;
  const typed = (asking === "approve" ? "a" : asking === "skip" ? "s" : "") + ev.key;
  if (!act.type(typed)) return false;
  ev.preventDefault();
  return true;
}

/**
 * Where focus goes when the focused card is about to leave the conversation, as a decided draft under "Drafts waiting"
 * does: the next card, else the one before, else the input. Never nowhere, where the next j or k would move the canvas.
 */
export function focusAfterLeaving(card: unknown, root: CardRoot, input: Focusable | null) {
  const cards: Focusable[] = reachableCards(root);
  const at = cards.indexOf(card as Focusable);
  const next = at < 0 ? undefined : (cards[at + 1] ?? cards[at - 1]);
  if (next) show(next);
  else input?.focus();
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
