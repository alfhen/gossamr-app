import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Need } from "../lib/needs";
import { HigherPriority, EDIT_FIELD, advancedText, nextAdvanced, endEditing, firstDecision } from "./NeedsPane";

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
