import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Need } from "../lib/needs";
import { closeTarget, lastNeedText, HigherPriority, EDIT_FIELD, advancedText, doneText, skippedDraft, postedToJira, postedWhat, postedFor, nextAdvanced, advancedUndone, advancedStale, endEditing, firstDecision, paneStop, useNeedTitle } from "./NeedsPane";
import { keepEditsOfDraft } from "./DraftCard";

/** A stand-in for the pane: each selector it is asked for answers with what the test put there. */
const pane = (found: Record<string, unknown[]>) =>
  ({
    querySelector: (s: string) => (found[s] ?? [])[0] ?? null,
    querySelectorAll: (s: string) => found[s] ?? [],
  }) as unknown as HTMLElement;
const body = "[data-needs-pane-body]";

describe("firstDecision", () => {
  it("lands a draft on its card, not on its post button, so approving takes a and then Enter", () => {
    const card = { id: "card" };
    const post = { id: "post" };
    const root = pane({ [`${body} [data-draft][tabindex="0"]`]: [card], [`${body} [data-draft-actions] button:not(:disabled)`]: [{ id: "skip" }, post] });
    expect(firstDecision(root)).toBe(card);
  });

  it("still prefers a permission's buttons and an answer box over a card", () => {
    const allow = { id: "allow" };
    expect(firstDecision(pane({ [`${body} [data-permission-decisions] button:not(:disabled)`]: [allow], [`${body} [data-draft][tabindex="0"]`]: [{}] }))).toBe(allow);
    const box = { id: "box" };
    expect(firstDecision(pane({ [`${body} textarea:not(:disabled)`]: [box], [`${body} [data-draft][tabindex="0"]`]: [{}] }))).toBe(box);
  });

  it("falls back to the action bar's last button where there is no card", () => {
    const post = { id: "post" };
    expect(firstDecision(pane({ [`${body} [data-draft-actions] button:not(:disabled)`]: [{ id: "skip" }, post] }))).toBe(post);
  });
});

describe("paneStop (G33)", () => {
  it("is the pane's heading, as Enter on a row lands, and the pane when it has none", () => {
    const heading = { id: "heading" };
    expect(paneStop({ querySelector: (s: string) => (s === "[data-needs-pane-title]" ? heading : null) } as unknown as HTMLElement)).toBe(heading);
    const bare = { querySelector: () => null } as unknown as HTMLElement;
    expect(paneStop(bare)).toBe(bare);
  });
});

describe("the edit field", () => {
  it("matches a textarea, a typeless input (a rewrite's title) and a text input, and not a checkbox", () => {
    const parts = EDIT_FIELD.split(", ").map((x) => x.replace("[data-needs-pane-body] ", ""));
    expect(parts).toEqual(["textarea", "input:not([type])", "input[type=text]"]);
  });
});

describe("Esc while a card is being edited", () => {
  const button = (text: string, over: Record<string, unknown> = {}) => ({ textContent: ` ${text} `, disabled: false, click: vi.fn(), ...over });

  it("clicks Done editing and says it did, so the decision stays open", () => {
    const done = button("Done editing");
    expect(endEditing(pane({ [`${body} button`]: [button("Skip"), done] }))).toBe(true);
    expect(done.click).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and says so, when nothing is being edited", () => {
    const edit = button("Edit");
    expect(endEditing(pane({ [`${body} button`]: [edit, button("Skip")] }))).toBe(false);
    expect(edit.click).not.toHaveBeenCalled();
  });
});

describe("the line when the pane moves on", () => {
  it("says what was done and what is open now", () => {
    expect(advancedText({ title: "Draft comment" }, { title: "R2 asks a question" })).toBe("Done: Draft comment. Now: R2 asks a question");
  });
});

describe("the line names the workstream the done need was in (G19)", () => {
  it("says it by the ticket, else the workstream's title, and leaves it out for General", () => {
    expect(doneText({ title: "Draft comment", ticketKey: "DEVOPS-490", workstreamTitle: "Fix the deploy" })).toBe("Done: Draft comment on DEVOPS-490.");
    expect(doneText({ title: "Reply", workstreamTitle: "Fix the deploy" })).toBe("Done: Reply on Fix the deploy.");
    expect(doneText({ title: "Reply" })).toBe("Done: Reply.");
    // A title that starts with the ticket does not repeat it, and a question is not read out as an action.
    expect(doneText({ title: "CA-408: start the build now?", ticketKey: "CA-408" })).toBe('Done: decided "start the build now?" on CA-408.');
    // A key that is only the start of the title's key is not the title's ticket.
    expect(doneText({ title: "CA-408: start the build now?", ticketKey: "CA-40" })).toBe("Done: CA-408: start the build now? on CA-40.");
    expect(doneText({ title: "CA-408", ticketKey: "CA-408" })).toBe("Done: CA-408.");
    // A space alone separates the key too, and is not quoted.
    expect(doneText({ title: "CA-408 Questions?", ticketKey: "CA-408" })).toBe('Done: decided "Questions?" on CA-408.');
    expect(doneText({ title: "CA-408 - plan now?", ticketKey: "CA-408" }, true)).toBe('Posted to Jira: decided "plan now?" on CA-408.');
    expect(doneText({ title: "CA-408 · Draft comment", ticketKey: "CA-408" })).toBe("Done: CA-408 · Draft comment.");
    expect(doneText({ title: "CA-408: Draft comment", ticketKey: "CA-408" })).toBe("Done: CA-408: Draft comment.");
  });

  it("carries the way back to that workstream", () => {
    expect(nextAdvanced(null, "t", { workstreamId: "w1", label: "Done: x on CA-1." }).back).toEqual({ workstreamId: "w1", label: "Done: x on CA-1." });
    expect(nextAdvanced(null, "t")).not.toHaveProperty("back");
  });
});

describe("the line says what was posted to Jira and where the next need is (G5)", () => {
  const draft = (type: string, state: string) => ({ id: "d1", intent: { type }, state: { type: state } }) as unknown as Parameters<typeof postedToJira>[1][string];
  const done = { target: { type: "draft", id: "d1" } } as Parameters<typeof postedToJira>[0];
  it("says Posted to Jira for an applied Jira write, else Done", () => {
    expect(doneText({ title: "Draft comment", ticketKey: "CA-1" }, true)).toBe("Posted to Jira: Draft comment on CA-1.");
    expect(postedToJira(done, { d1: draft("comment", "applied") })).toBe(true);
    expect(postedToJira(done, { d1: draft("transition", "applying") })).toBe(true);
    expect(postedToJira(done, { d1: draft("comment", "skipped") })).toBe(false);
    expect(postedToJira(done, { d1: draft("githubReview", "applied") })).toBe(false);
    expect(postedToJira(done, {})).toBe(false);
  });
  it("names the next need's ticket", () => {
    expect(advancedText({ title: "Reply" }, { title: "Next", ticketKey: "SUP-9" }, true)).toBe("Posted to Jira: Reply. Now: SUP-9 · Next");
  });
});

describe("the advanced line's id", () => {
  it("differs for two advances with the same words, so the line and its timer start over", () => {
    const text = advancedText({ title: "Reply" }, { title: "Reply" });
    const first = nextAdvanced(null, text);
    const second = nextAdvanced(first, text);
    expect(second.text).toBe(first.text);
    expect(second.id).not.toBe(first.id);
    expect(second).not.toEqual(first);
  });
});

describe("the advanced line after Undo", () => {
  const line = nextAdvanced(null, "Done: Draft comment on CA-402. Now: CA-408", undefined, "need-402");
  it("goes when the done need is back in the list, and stays while it is gone", () => {
    expect(advancedUndone(line, [{ key: "need-408" }])).toBe(false);
    expect(advancedUndone(line, [{ key: "need-402" }, { key: "need-408" }])).toBe(true);
  });
  it("never goes for a line that names no need, or no line", () => {
    expect(advancedUndone(nextAdvanced(null, "x"), [{ key: "need-402" }])).toBe(false);
    expect(advancedUndone(null, [{ key: "need-402" }])).toBe(false);
  });
});

describe("the higher-priority bar's snapshot", () => {
  const n = (key: string, group: Need["group"], at: string) => ({ key, group, at, title: `Title ${key}` }) as Need;
  const open = n("open", "unblock", "2026-10-01T10:00:00Z");
  const early = n("e", "decide", "2026-10-01T09:00:00Z");

  it("is state taken when the decision mounts: needs already there then are not news, and the component holds no ref written in render", () => {
    expect(renderToStaticMarkup(<HigherPriority needs={[open, early]} need={open} />)).toBe("");
  });

  it("takes its snapshot per mount, so a mount without the early need sees it as new once it is there", () => {
    // Two separate mounts stand for two decisions (the pane keys it by the open need): each has its own snapshot.
    expect(renderToStaticMarkup(<HigherPriority needs={[open]} need={open} />)).toBe("");
    expect(renderToStaticMarkup(<HigherPriority needs={[open, early]} need={open} />)).toBe("");
  });
});

describe("the decision's title follows an edited draft (G5)", () => {
  const need = { key: "draft:p9", kind: "draft", title: "Draft comment: “Old words here”", target: { type: "draft", id: "p9" } } as unknown as Need;
  const Title = ({ n }: { n: Need }) => {
    const { title, edited } = useNeedTitle(n);
    return <span data-edited={edited}>{title}</span>;
  };

  it("quotes the words as edited, and says so, where the stored text would be the stale ones", () => {
    expect(renderToStaticMarkup(<Title n={need} />)).toContain("Old words here");
    keepEditsOfDraft("p9", { body: { text: "Brand new wording instead", mentions: [] } });
    try {
      const out = renderToStaticMarkup(<Title n={need} />);
      expect(out).toContain("Brand new wording instead");
      expect(out).not.toContain("Old words here");
      expect(out).toContain('data-edited="true"');
    } finally {
      keepEditsOfDraft("p9", {});
    }
    // A need that is no draft keeps its title.
    expect(renderToStaticMarkup(<Title n={{ ...need, target: { type: "run", id: "r1" } } as unknown as Need} />)).toContain("Old words here");
  });
});

describe("Esc from a decision (G7)", () => {
  const el = (over: Record<string, unknown> = {}) => ({ tagName: "BUTTON", isConnected: true, ...over }) as unknown as HTMLElement;
  const row = el({ id: "row" });
  const paneOf = (inside: unknown[]) => ({ contains: (n: unknown) => inside.includes(n) });

  it("gives the keyboard back to what opened the need, such as a button elsewhere on the page", () => {
    const open = el();
    expect(closeTarget(open, paneOf([]), () => row)).toBe(open);
  });

  it("goes to the need's row when the opener is gone, inside the pane, or was the page itself", () => {
    const inside = el();
    expect(closeTarget(el({ isConnected: false }), paneOf([]), () => row)).toBe(row);
    expect(closeTarget(inside, paneOf([inside]), () => row)).toBe(row);
    expect(closeTarget(el({ tagName: "BODY" }), paneOf([]), () => row)).toBe(row);
    expect(closeTarget(null, null, () => row)).toBe(row);
  });
});

describe("lastNeedText", () => {
  const need = { key: "draft:p1", kind: "draft", title: "Draft comment", ticketKey: "CA-401", workstreamId: null, target: { type: "draft", id: "p1" } } as unknown as Need;
  const withState = (type: string) => ({ p1: { id: "p1", state: { type }, intent: { type: "comment" } } }) as never;

  it("says nothing when the last draft was skipped or retired, which its own Undo note covers", () => {
    expect(lastNeedText(need, withState("retired"))).toBeNull();
    expect(lastNeedText(need, withState("pending"))).toBeNull();
    expect(lastNeedText(need, {} as never)).toBeNull();
  });

  it("says what was done when the draft was posted", () => {
    expect(lastNeedText(need, withState("applied"))).toMatch(/^(Done|Posted to Jira): Draft comment on CA-401\.$/);
  });
});

describe("the Done line names what Jira got (G7)", () => {
  const need = { key: "draft:p1", kind: "draft", title: "Approve the plan", ticketKey: "CA-401", workstreamId: null, target: { type: "draft", id: "p1" } } as unknown as Need;
  const item = { connectionId: "c", externalId: "1", key: "CA-401" };
  const props = (intent: object, type = "applied") => ({ p1: { id: "p1", state: { type }, intent } }) as never;
  it("says a rewrite updated the description, not that the card was approved", () => {
    const p = props({ type: "rewrite", item, title: null, body: {}, flattened: [] });
    expect(postedWhat(need, p)).toBe("Updated the description of CA-401 in Jira.");
    expect(lastNeedText(need, p)).toBe("Updated the description of CA-401 in Jira.");
    expect(advancedText(need, { title: "Next" }, postedFor(need, p))).toBe("Updated the description of CA-401 in Jira. Now: Next");
  });
  it("says a rewrite of both the title and the description updated both, and one alone only that one", () => {
    const both = props({ type: "rewrite", item, title: { from: "a", to: "b" }, body: {}, flattened: [] });
    expect(postedWhat(need, both)).toBe("Updated the title and description of CA-401 in Jira.");
    expect(postedWhat(need, props({ type: "rewrite", item, title: { from: "a", to: "b" }, body: null }))).toBe("Updated the title of CA-401 in Jira.");
    expect(postedWhat(need, props({ type: "rewrite", item, title: null, body: {} }))).toBe("Updated the description of CA-401 in Jira.");
  });
  it("does not say subtasks were created while the draft is still applying", () => {
    const subtasks = { type: "subtasks", parent: item, summaries: ["a", "b"] };
    expect(postedWhat(need, props(subtasks, "applying"))).toBeNull();
    expect(postedToJira(need, props(subtasks, "applying"))).toBe(true);
    expect(postedWhat(need, props(subtasks, "applied"))).toBe("Created 2 subtasks on CA-401 in Jira.");
  });
  it("counts the subtasks created, and leaves a comment on the card's title", () => {
    expect(lastNeedText(need, props({ type: "subtasks", parent: item, summaries: ["a", "b"] }))).toBe("Created 2 subtasks on CA-401 in Jira.");
    expect(postedWhat(need, props({ type: "subtasks", parent: item, summaries: ["a"] }))).toBe("Created 1 subtask on CA-401 in Jira.");
    expect(lastNeedText(need, props({ type: "comment" }))).toBe("Posted to Jira: Approve the plan on CA-401.");
    expect(postedWhat(need, props({ type: "rewrite", item, title: null, body: {} }, "pending"))).toBeNull();
  });
});

describe("the Done line goes stale (G4)", () => {
  const line = nextAdvanced(null, "Done: Ask on CA-1. Now waits on Mette. Now: CA-2 · Reply", { workstreamId: "w1", label: "Done: Ask on CA-1." }, "need-1", "need-2");
  it("goes once another need than the one it names is open", () => {
    expect(advancedStale(line, "need-2")).toBe(false);
    expect(advancedStale(line, "need-9")).toBe(true);
    expect(advancedStale(null, "need-9")).toBe(false);
  });
});

describe("a skipped draft's line (G6)", () => {
  it("says Skipped, not Done, and a posted or plain need is unchanged", () => {
    expect(advancedText({ title: "Approve the plan", ticketKey: "CA-401" }, { title: "R2 asks a question" }, false, true)).toBe("Skipped: Approve the plan on CA-401. Now: R2 asks a question");
    expect(advancedText({ title: "Approve the plan", ticketKey: "CA-401" }, { title: "R2 asks a question" })).toBe("Done: Approve the plan on CA-401. Now: R2 asks a question");
    expect(doneText({ title: "Reply" }, false, true)).toBe("Skipped: Reply.");
  });

  it("is a skip only when the draft's state is skipped", () => {
    const need = { target: { type: "draft", id: "p1" } } as never;
    expect(skippedDraft(need, { p1: { state: { type: "skipped" } } } as never)).toBe(true);
    expect(skippedDraft(need, { p1: { state: { type: "applied" } } } as never)).toBe(false);
  });
});
