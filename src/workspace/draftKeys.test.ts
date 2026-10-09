import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal, ProposalState, RunSpec } from "../types";
import { DRAFT_CARD, draftKeyAction, draftKeyHint, draftKeyShortcuts, focusAfterLeaving, onDraftCardKey, stepDraftCards, upToNewestDraft, type Asking } from "./draftKeys";

const ref = itemRef("CA-412");
const spec: RunSpec = { kind: "investigate", repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: "ca-412-fix-ab12", instruction: "Investigate this work." };

const INTENTS: Record<Intent["type"], Intent> = {
  comment: { type: "comment", item: ref, body: docFromText("Checking in.") },
  transition: { type: "transition", item: ref, to: "31" },
  subtasks: { type: "subtasks", parent: ref, summaries: ["One", "Two"] },
  create: { type: "create", container: { connectionId: "mock", externalId: "CA" }, fields: { title: "New", body: docFromText("") } as never, link: null },
  link: { type: "link", from: ref, to: itemRef("CA-401"), kind: "relates" as never },
  update: { type: "update", item: ref, patch: {} as never },
  rewrite: { type: "rewrite", item: ref, title: { from: "Old", to: "New" }, body: null, flattened: [] },
  startRun: { type: "startRun", connectionId: "mock", item: ref, spec },
  followUp: { type: "followUp", connectionId: "mock", runId: "run-1", item: ref, message: "Again.", reason: "open questions" },
};

const STATES: ProposalState[] = [{ type: "pending" }, { type: "applying" }, { type: "applied" }, { type: "skipped" }, { type: "retired", reason: "The ticket moved on" }];

const draft = (intent: Intent, state: ProposalState = { type: "pending" }): Proposal => ({
  id: "p1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r1" } as Proposal["origin"],
  createdBy: "pip",
  intent,
  label: null,
  basis: null,
  state,
  revisions: [],
  created: [],
  error: null,
  run: null,
});

const INLINE = new Set(["comment", "transition", "subtasks", "create", "link", "update"]);
const KEYS = ["a", "s", "Enter", "o", "x", "A", "ArrowUp", " "];

/** What each key should do, written out once so the table below reads as the rule. */
function expected(type: Intent["type"], state: ProposalState["type"], key: string) {
  if (key === "Enter" || key === "o") return "open";
  if (state !== "pending") return null;
  if (key === "a") return INLINE.has(type) ? "approve" : "open";
  if (key === "s") return "skip";
  return null;
}

describe("draftKeyAction", () => {
  const cases = Object.keys(INTENTS).flatMap((type) => STATES.flatMap((state) => KEYS.map((key) => [type as Intent["type"], state, key] as const)));

  it.each(cases)("%s, %o, key %j", (type, state, key) => {
    expect(draftKeyAction(draft(INTENTS[type], state), key)).toBe(expected(type, state.type, key));
  });

  it("opens a rewrite on a, so its diff is read before anything changes", () => {
    expect(draftKeyAction(draft(INTENTS.rewrite), "a")).toBe("open");
  });

  it("never approves a run or a follow-up from a key, whatever its state", () => {
    for (const type of ["startRun", "followUp"] as const) {
      for (const state of STATES) for (const key of KEYS) expect(draftKeyAction(draft(INTENTS[type], state), key)).not.toBe("approve");
      expect(draftKeyAction(draft(INTENTS[type]), "a")).toBe("open");
    }
  });

  it("never approves or skips a decided draft", () => {
    for (const type of Object.keys(INTENTS) as Intent["type"][]) {
      for (const state of STATES.filter((s) => s.type !== "pending")) {
        for (const key of KEYS) expect(["approve", "skip"]).not.toContain(draftKeyAction(draft(INTENTS[type], state), key));
      }
    }
  });
});

describe("the focused card's hint and shortcuts", () => {
  it("offers approve only where a approves", () => {
    expect(draftKeyHint(draft(INTENTS.comment))).toBe("a approve · s skip · ↵ open");
    expect(draftKeyHint(draft(INTENTS.startRun))).toBe("s skip · ↵ open");
    expect(draftKeyHint(draft(INTENTS.rewrite))).toBe("s skip · ↵ open");
    expect(draftKeyHint(draft(INTENTS.comment, { type: "applied" }))).toBe("↵ open");
    expect(draftKeyShortcuts(draft(INTENTS.comment))).toBe("a s Enter o");
    expect(draftKeyShortcuts(draft(INTENTS.comment, { type: "skipped" }))).toBe("Enter o");
  });

  it("says what Enter confirms while a decision waits for it", () => {
    expect(draftKeyHint(draft(INTENTS.comment), "approve")).toBe("↵ approve · any other key cancels");
    expect(draftKeyHint(draft(INTENTS.comment), "skip")).toBe("↵ skip · any other key cancels");
  });
});

/** Just enough of an element for the key handlers: they look for cards with `matches` and move focus with `focus`. */
const card = (state = "pending") => {
  const el = { focus: vi.fn(), scrollIntoView: vi.fn(), matches: (sel: string) => sel === DRAFT_CARD, getAttribute: (name: string) => (name === "data-state" ? state : null) };
  return el;
};
const rootOf = (cards: object[]) => ({ querySelectorAll: (sel: string) => (sel === DRAFT_CARD ? cards : []) });
const key = (k: string, target: unknown, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; currentTarget: unknown }> = {}) => ({
  key: k,
  target,
  currentTarget: target,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  preventDefault: vi.fn(),
  ...over,
});

describe("onDraftCardKey", () => {
  /** The card's handlers, with the decision it waits on kept the way the card keeps it. */
  const acts = () => {
    const a = { approve: vi.fn(), skip: vi.fn(), open: vi.fn(), asking: null as Asking | null, typed: [] as string[], ask: vi.fn(), type: vi.fn() };
    a.ask.mockImplementation((next: Asking | null) => (a.asking = next));
    a.type.mockImplementation((text: string) => (a.typed.push(text), true));
    return a;
  };
  /** Presses `keys` on `el` in turn, as the card would see them, and returns the last result. */
  const press = (a: ReturnType<typeof acts>, p: Proposal, keys: string[], el: unknown = card()) => keys.reduce((_, k) => onDraftCardKey(key(k, el), p, a.asking, a), false);

  it("asks on a and approves on the Enter after it, once", () => {
    const a = acts();
    const ev = key("a", card());
    expect(onDraftCardKey(ev, draft(INTENTS.comment), a.asking, a)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(a.asking).toBe("approve");
    expect(a.approve).not.toHaveBeenCalled();
    expect(press(a, draft(INTENTS.comment), ["Enter"])).toBe(true);
    expect(a.approve).toHaveBeenCalledTimes(1);
    expect(a.asking).toBeNull();
    expect(a.open).not.toHaveBeenCalled();
  });

  it("skips on s and then Enter", () => {
    const a = acts();
    press(a, draft(INTENTS.comment), ["s", "Enter"]);
    expect(a.skip).toHaveBeenCalledTimes(1);
    expect(a.approve).not.toHaveBeenCalled();
  });

  it("cancels on Escape or any other key, and Enter then opens instead", () => {
    const a = acts();
    press(a, draft(INTENTS.comment), ["a", "Escape", "Enter"]);
    expect(a.approve).not.toHaveBeenCalled();
    expect(a.open).toHaveBeenCalledTimes(1);
    press(a, draft(INTENTS.comment), ["s", "ArrowDown", "Enter"]);
    expect(a.skip).not.toHaveBeenCalled();
    expect(a.open).toHaveBeenCalledTimes(2);
  });

  it("never decides a draft from text typed after ArrowUp, and gives the text back to the input", () => {
    // A text that starts with o opens the ticket, which writes nothing; these are the ones that start with a card's decision keys.
    for (const text of ["add a note", "show me the drafts", "sure", "a", "s", "As it says", "aaa", "ss"]) {
      const a = acts();
      const p = draft(INTENTS.comment);
      for (const k of [...text]) {
        if (a.typed.length) break; // Once the input has the focus again, the rest is typed there.
        onDraftCardKey(key(k, card(), { shiftKey: k !== k.toLowerCase() }), p, a.asking, a);
      }
      expect(a.approve).not.toHaveBeenCalled();
      expect(a.skip).not.toHaveBeenCalled();
      if (a.typed.length) expect(text.startsWith(a.typed[0])).toBe(true);
    }
    const a = acts();
    press(a, draft(INTENTS.comment), ["a", "d"]);
    expect(a.typed).toEqual(["ad"]);
    expect(a.asking).toBeNull();
  });

  it("ignores keys from inside the card and modifier combinations", () => {
    const a = acts();
    const el = card();
    expect(onDraftCardKey(key("a", { tagName: "BUTTON" }, { currentTarget: el }), draft(INTENTS.comment), null, a)).toBe(false);
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) expect(onDraftCardKey(key("a", el, { [mod]: true }), draft(INTENTS.comment), null, a)).toBe(false);
    expect(onDraftCardKey(key("Enter", el, { shiftKey: true }), draft(INTENTS.comment), "approve", a)).toBe(false);
    expect(a.approve).not.toHaveBeenCalled();
    expect(a.ask).not.toHaveBeenCalledWith("approve");
  });

  it("opens a run draft on a, and has nothing to approve with", () => {
    const a = acts();
    press(a, draft(INTENTS.startRun), ["a"]);
    expect(a.open).toHaveBeenCalledTimes(1);
    expect(a.ask).not.toHaveBeenCalled();
    expect(a.approve).not.toHaveBeenCalled();
  });

  it("leaves j and k to the conversation, even while asking", () => {
    const a = acts();
    expect(press(a, draft(INTENTS.comment), ["a", "j"])).toBe(false);
    expect(a.asking).toBeNull();
    expect(a.typed).toEqual([]);
  });

  it("does nothing when the card has no handler for the action", () => {
    const ev = key("a", card());
    expect(onDraftCardKey(ev, draft(INTENTS.comment), null, { open: vi.fn(), ask: vi.fn() })).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});

describe("focusAfterLeaving", () => {
  it("moves to the next card, else the one before, else the input", () => {
    const cards = [card(), card(), card()];
    const input = card();
    focusAfterLeaving(cards[1], rootOf(cards), input);
    expect(cards[2].focus).toHaveBeenCalled();
    focusAfterLeaving(cards[2], rootOf(cards), input);
    expect(cards[1].focus).toHaveBeenCalled();
    focusAfterLeaving(cards[0], rootOf([cards[0]]), input);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });
});

describe("moving between cards", () => {
  it("steps down and up with the arrows and j and k, staying put at the ends", () => {
    const cards = [card(), card("applied"), card()];
    const root = rootOf(cards);
    expect(stepDraftCards(key("ArrowDown", cards[0]), root)).toBe(true);
    expect(cards[1].focus).toHaveBeenCalled();
    stepDraftCards(key("j", cards[1]), root);
    expect(cards[2].focus).toHaveBeenCalled();
    stepDraftCards(key("k", cards[2]), root);
    expect(cards[1].focus).toHaveBeenCalledTimes(2);
    stepDraftCards(key("ArrowUp", cards[1]), root);
    expect(cards[0].focus).toHaveBeenCalledTimes(1);
    const top = key("ArrowUp", cards[0]);
    expect(stepDraftCards(top, root)).toBe(true);
    expect(top.preventDefault).toHaveBeenCalled();
    expect(cards[0].focus).toHaveBeenCalledTimes(1);
  });

  it("leaves keys alone that come from anything but a card", () => {
    const cards = [card(), card()];
    const input = { id: "pip-input", matches: () => false };
    const ev = key("ArrowDown", input);
    expect(stepDraftCards(ev, rootOf(cards))).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(stepDraftCards(key("ArrowDown", cards[0], { ctrlKey: true }), rootOf(cards))).toBe(false);
    for (const c of cards) expect(c.focus).not.toHaveBeenCalled();
  });

  it("goes from the empty input up to the newest draft still waiting", () => {
    const cards = [card(), card(), card("applied")];
    const ev = key("ArrowUp", null);
    expect(upToNewestDraft(ev, "", rootOf(cards))).toBe(true);
    expect(cards[1].focus).toHaveBeenCalled();
    expect(cards[0].focus).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it("keeps ArrowUp for the text when the input has some, and does nothing with no draft waiting", () => {
    const cards = [card()];
    expect(upToNewestDraft(key("ArrowUp", null), "draft a comment", rootOf(cards))).toBe(false);
    expect(upToNewestDraft(key("ArrowUp", null, { shiftKey: true }), "", rootOf(cards))).toBe(false);
    expect(upToNewestDraft(key("ArrowDown", null), "", rootOf(cards))).toBe(false);
    expect(cards[0].focus).not.toHaveBeenCalled();
    const ev = key("ArrowUp", null);
    expect(upToNewestDraft(ev, "", rootOf([card("skipped")]))).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});
