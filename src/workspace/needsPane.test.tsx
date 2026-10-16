import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Need } from "../lib/needs";
import { ReporterReplyQuote, closeTarget, lastNeedText, HigherPriority, EDIT_FIELD, advancedText, closedText, doneText, postedToJira, waitStarted, nextAdvanced, advancedUndone, endEditing, firstDecision, paneStop } from "./NeedsPane";

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
    expect(advancedText({ title: "Questions for the reporter" }, { title: "R2 asks a question" }, "CA-408 now waits on the reporter; nothing starts on its own")).toBe(
      "Done: Questions for the reporter. CA-408 now waits on the reporter; nothing starts on its own. Now: R2 asks a question",
    );
  });
});

describe("the line names the workstream the done need was in (G19)", () => {
  it("says it by the ticket, else the workstream's title, and leaves it out for General", () => {
    expect(doneText({ title: "Questions for the reporter", ticketKey: "DEVOPS-490", workstreamTitle: "Fix the deploy" })).toBe("Done: Questions for the reporter on DEVOPS-490.");
    expect(doneText({ title: "Reply", workstreamTitle: "Fix the deploy" })).toBe("Done: Reply on Fix the deploy.");
    expect(doneText({ title: "Reply" })).toBe("Done: Reply.");
    // A title that starts with the ticket does not repeat it, and a question is not read out as an action.
    expect(doneText({ title: "CA-408: the reporter replied, plan now?", ticketKey: "CA-408" })).toBe('Done: decided "the reporter replied, plan now?" on CA-408.');
    // A key that is only the start of the title's key is not the title's ticket.
    expect(doneText({ title: "CA-408: the reporter replied, plan now?", ticketKey: "CA-40" })).toBe("Done: CA-408: the reporter replied, plan now? on CA-40.");
    expect(doneText({ title: "CA-408", ticketKey: "CA-408" })).toBe("Done: CA-408.");
    // A space alone separates the key too, and is not quoted.
    expect(doneText({ title: "CA-408 Questions?", ticketKey: "CA-408" })).toBe('Done: decided "Questions?" on CA-408.');
    expect(doneText({ title: "CA-408 - plan now?", ticketKey: "CA-408" }, true)).toBe('Posted to Jira: decided "plan now?" on CA-408.');
    expect(doneText({ title: "CA-408 · Questions for the reporter", ticketKey: "CA-408" })).toBe("Done: CA-408 · Questions for the reporter.");
    expect(doneText({ title: "CA-408: Questions for the reporter", ticketKey: "CA-408" })).toBe("Done: CA-408: Questions for the reporter.");
    expect(advancedText({ title: "Questions", ticketKey: "CA-408" }, { title: "R2 asks a question" }, "CA-408 now waits on the reporter")).toBe("Done: Questions on CA-408. CA-408 now waits on the reporter. Now: R2 asks a question");
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
    expect(advancedText({ title: "Reply" }, { title: "Next", ticketKey: "SUP-9" }, null, true)).toBe("Posted to Jira: Reply. Now: SUP-9 · Next");
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
  const line = nextAdvanced(null, "Done: Questions for the reporter on CA-402. Now: CA-408", undefined, "need-402");
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

describe("what posting to the reporter starts, said when Pip moves on", () => {
  const draft = (label: string, state: string, createdBy = "agent") => ({ id: "d1", label, createdBy, intent: { type: "comment" }, state: { type: state } }) as unknown as Parameters<typeof waitStarted>[1][string];
  const done = { target: { type: "draft", id: "d1" }, ticketKey: "CA-408" } as Parameters<typeof waitStarted>[0];

  it("names the wait after the questions or the nudge were posted", () => {
    expect(waitStarted(done, { d1: draft("Questions for the reporter", "applied") })).toBe("CA-408 now waits on the reporter; nothing starts on its own");
    expect(waitStarted(done, { d1: draft("Nudge for the reporter", "applying") })).toBe("CA-408 now waits on the reporter; nothing starts on its own");
    expect(waitStarted({ ...done, ticketKey: undefined }, { d1: draft("Questions for the reporter", "applied") })).toMatch(/^The workstream now waits/);
  });

  it("says nothing for a skipped draft, another comment, a need that is no draft, or a draft it can't find", () => {
    expect(waitStarted(done, { d1: draft("Questions for the reporter", "skipped") })).toBeNull();
    expect(waitStarted(done, { d1: draft("Draft comment", "applied") })).toBeNull();
    expect(waitStarted(done, { d1: draft("Questions for the reporter", "applied", "pip") })).toBeNull();
    expect(waitStarted({ ...done, target: { type: "run", id: "r1" } } as Parameters<typeof waitStarted>[0], { d1: draft("Questions for the reporter", "applied") })).toBeNull();
    expect(waitStarted(done, {})).toBeNull();
  });
});

describe("Esc from a decision (G7)", () => {
  const el = (over: Record<string, unknown> = {}) => ({ tagName: "BUTTON", isConnected: true, ...over }) as unknown as HTMLElement;
  const row = el({ id: "row" });
  const paneOf = (inside: unknown[]) => ({ contains: (n: unknown) => inside.includes(n) });

  it("gives the keyboard back to what opened the need, such as Start my day's Open", () => {
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

describe("the reporter's reply in the decision (G4)", () => {
  it("quotes the reply and offers to open the comment", () => {
    const html = renderToStaticMarkup(<ReporterReplyQuote reply={{ id: "c1", excerpt: "It should send three emails." }} ticketKey="CA-408" />);
    expect(html).toContain("The reporter replied");
    expect(html).toContain("“It should send three emails.”");
    expect(html).toContain("Open their comment");
  });

  it("shows nothing without a reply, and no link without a ticket", () => {
    expect(renderToStaticMarkup(<ReporterReplyQuote reply={undefined} ticketKey="CA-408" />)).toBe("");
    expect(renderToStaticMarkup(<ReporterReplyQuote reply={{ id: "c1", excerpt: "Yes." }} ticketKey={null} />)).not.toContain("Open their comment");
  });
});

describe("the last need decided from the pane (G6)", () => {
  it("says what was posted and the wait it started, since no pane line is left to say it", () => {
    expect(closedText({ title: "Questions for the reporter", ticketKey: "CA-408" }, "CA-408 now waits on the reporter; nothing starts on its own", true)).toBe(
      "Posted to Jira: Questions for the reporter on CA-408. CA-408 now waits on the reporter; nothing starts on its own.",
    );
  });
  it("is the Done line alone when nothing was posted or started", () => {
    expect(closedText({ title: "Draft comment" })).toBe("Done: Draft comment.");
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
