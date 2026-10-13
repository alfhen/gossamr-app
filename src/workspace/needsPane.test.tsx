import { describe, expect, it, vi } from "vitest";
import { EDIT_FIELD, endEditing, firstDecision } from "./NeedsPane";

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
