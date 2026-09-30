import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkEvent } from "../types";
import { CommentCard, HistoryRow, SectionCard, SectionNav } from "./PeekParts";
import { displayName, fieldLine, historyNotes, initials, isCollapsed, sectionChips, statusMove, type Note } from "./peekLogic";
import { usePrefs } from "./prefs";

const event = (kind: WorkEvent["kind"], payload: unknown, actor: string | null = "a1"): WorkEvent => ({
  id: `${kind}-${String(payload)}`,
  connectionId: "mock",
  at: "2026-09-01T10:00:00Z",
  kind,
  subject: { type: "item", item: { connectionId: "mock", externalId: "X-1", key: "X-1" } },
  actor: actor ? { connectionId: "mock", accountId: actor } : null,
  payload,
});

const NOW = new Date("2026-09-01T12:00:00Z");
const note = (over: Partial<Note> = {}): Note => ({ id: "n", at: "2026-09-01T10:00:00Z", who: "Sam Holt", text: "Hello", ...over });

describe("section navigation", () => {
  it("lists description and comments always, links and history when they have rows", () => {
    expect(sectionChips({ links: 0, comments: 0, history: 0 }).map((c) => c.id)).toEqual(["description", "comments"]);
    const all = sectionChips({ links: 5, comments: 4, history: 2 });
    expect(all.map((c) => [c.id, c.count])).toEqual([["description", undefined], ["links", 5], ["comments", 4], ["history", 2]]);
  });

  it("renders a chip per section with the comment count", () => {
    const out = renderToStaticMarkup(<SectionNav chips={sectionChips({ links: 1, comments: 4, history: 0 })} />);
    expect(out).toContain('aria-label="Sections"');
    expect(out).toMatch(/Comments.*>4</);
    expect(out).not.toContain("History");
  });
});

describe("section cards", () => {
  it("are open by default and fold to a header, keeping the body mounted so a half-written comment survives", () => {
    expect(isCollapsed({}, "comments")).toBe(false);
    expect(isCollapsed({ comments: true }, "comments")).toBe(true);
    const open = renderToStaticMarkup(<SectionCard id="comments" title="Comments" count={2} onToggle={vi.fn()}>body text</SectionCard>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("body text");
    expect(open).toContain('id="peek-comments"');
    const folded = renderToStaticMarkup(<SectionCard id="comments" title="Comments" count={2} collapsed onToggle={vi.fn()}>body text</SectionCard>);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toMatch(/<div[^>]*hidden=""[^>]*class="hidden /);
    expect(folded).toContain("body text");
  });

  it("has no toggle when it cannot be folded", () => {
    expect(renderToStaticMarkup(<SectionCard id="drafts" title="Drafts waiting">x</SectionCard>)).not.toContain("aria-expanded");
  });

  it("remembers folded sections in the prefs store without persisting them", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: () => {} });
    usePrefs.getState().setPeekSection("description", true);
    expect(isCollapsed(usePrefs.getState().peekCollapsed, "description")).toBe(true);
    usePrefs.getState().setPeekSection("description", false);
    expect(isCollapsed(usePrefs.getState().peekCollapsed, "description")).toBe(false);
  });
});

describe("comment cards", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

  it("shows initials, the author, a relative time with the full date on hover", () => {
    const out = renderToStaticMarkup(<CommentCard note={note()} now={NOW} />);
    expect(out).toContain(">SH<");
    expect(out).toContain("Sam Holt");
    expect(out).toContain('dateTime="2026-09-01T10:00:00Z"');
    expect(out).toMatch(/<time[^>]*title="[^"]+"/);
    expect(out).toContain('data-comment="other"');
    expect(out).not.toContain(">you<");
  });

  it("marks the signed-in person's own comment", () => {
    const out = renderToStaticMarkup(<CommentCard note={note({ mine: true })} now={NOW} />);
    expect(out).toContain('data-comment="mine"');
    expect(out).toContain(">you<");
  });

  it("renders mentions as chips and wraps long unbreakable text", () => {
    const doc = {
      blocks: [
        {
          type: "paragraph" as const,
          content: [
            { type: "mention" as const, person: { connectionId: "m", accountId: "a" }, name: "Alf" },
            { type: "text" as const, text: " https://example.com/" + "a".repeat(200), marks: [] },
          ],
        },
      ],
    };
    const out = renderToStaticMarkup(<CommentCard note={note({ doc })} now={NOW} />);
    expect(out).toContain("@Alf");
    expect(out).toContain("text-ws-accent");
    expect(out).toContain("[overflow-wrap:anywhere]");
    expect(out).toContain("min-w-0");
  });
});

describe("history", () => {
  const name = (id: string | null) => displayName({ a1: "Leigh Bertelsen" }, id);

  it("reads status moves from the payload, or from the stored text of older events", () => {
    expect(statusMove({ from: "To Do", to: "Doing" })).toEqual({ from: "To Do", to: "Doing" });
    expect(statusMove({ text: "In Progress → In Review" })).toEqual({ from: "In Progress", to: "In Review" });
    expect(statusMove({ text: "nothing to see" })).toBeNull();
    expect(statusMove(null)).toBeNull();
    const lines = historyNotes([event("statusChanged", { text: "In Progress → In Review" }), event("statusChanged", {})], name).map((n) => n.text);
    expect(lines).toContain("moved from In Progress to In Review");
    expect(lines).toContain("changed the status");
    expect(lines.join(" ")).not.toContain("another status");
  });

  it("labels assignments with who they went to where that is known", () => {
    const text = (payload: unknown) => historyNotes([event("assigned", payload)], name)[0].text;
    expect(text({ text: "Assigned to you" })).toBe("assigned it to you");
    expect(text({ to: "Sam" })).toBe("assigned it to Sam");
    expect(text({ from: "Ida", to: "Sam" })).toBe("changed the assignee from Ida to Sam");
    expect(text({})).toBe("changed the assignee");
  });

  it("words a field change by what moved", () => {
    expect(fieldLine({ field: "Priority", from: "High", to: "Low" })).toBe("changed the priority from High to Low");
    expect(fieldLine({ field: "Due date", to: "2026-10-01" })).toBe("set the due date to 2026-10-01");
    expect(fieldLine({ field: "Labels", from: "urgent" })).toBe("cleared the labels (was urgent)");
    expect(fieldLine({ text: "Priority High → Low" })).toBe("updated a field");
    expect(historyNotes([event("fieldChanged", { field: "Summary", from: "A", to: "B" })], name)[0].text).toBe("changed the summary from A to B");
  });

  it("names the actor, falling back to Someone for an opaque account id", () => {
    expect(displayName({ a1: "Leigh Bertelsen" }, "a1")).toBe("Leigh Bertelsen");
    expect(displayName({}, "557058:f58131cb-b67d-4c5e-a3a3-1f2e3d4c5b6a")).toBe("Someone");
    expect(displayName({}, "5b10ac8d82e05b22cc7d4ef5")).toBe("Someone");
    expect(displayName({}, null)).toBe("Someone");
    expect(displayName({}, "sam")).toBe("sam");
    const [h] = historyNotes([event("statusChanged", { from: "A", to: "B" }, "a1")], name, (id) => id === "a1");
    expect(h.who).toBe("Leigh Bertelsen");
    expect(h.mine).toBe(true);
  });

  it("shows the actor's initials on each row", () => {
    const out = renderToStaticMarkup(<HistoryRow note={note({ who: "Leigh Bertelsen", text: "moved from A to B" })} now={NOW} />);
    expect(out).toContain(">LB<");
    expect(out).toContain("moved from A to B");
    expect(initials("madonna")).toBe("M");
    expect(initials("  ")).toBe("?");
  });
});
