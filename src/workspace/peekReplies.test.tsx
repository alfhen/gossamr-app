import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docText, quoteAfterFirst } from "../lib/docs";
import type { WorkComment, WorkDoc, WorkEvent } from "../types";
import { itemRef } from "../backend/mockConnector";
import { CommentCard, SectionCard } from "./PeekParts";
import { EXCERPT_LENGTH, excerpt, newestFirst, ownText, replyDraft, shownComments, withReplies, type Note } from "./peekLogic";

const NOW = new Date("2026-09-01T12:00:00Z");
const P = (text: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text, marks: [] }] });
const mention = (name: string) => ({ type: "paragraph" as const, content: [{ type: "mention" as const, person: { connectionId: "c", accountId: name.toLowerCase() }, name }] });
const Q = (text: string) => ({ type: "quote" as const, content: [P(text)] });
const plain = (id: string, who: string, text: string, min = 0): Note => ({ id, who, text, at: `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`, doc: { blocks: [P(text)] }, accountId: who.toLowerCase() });
const replyNote = (id: string, who: string, doc: WorkDoc, min: number): Note => ({ id, who, text: "", at: `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`, doc });

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("excerpt", () => {
  it("keeps short text whole on one line and cuts long text at a word", () => {
    expect(excerpt("one\n  two   three")).toBe("one two three");
    const long = "word ".repeat(100);
    const cut = excerpt(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 1);
    expect(cut).not.toMatch(/\swor…$/);
  });
});

describe("withReplies", () => {
  const original = plain("a", "Sam Holt", "Ready for another look, retries now cap at five.", 1);

  it("leaves ordinary comments alone", () => {
    const out = withReplies([original, plain("b", "Ida", "Thanks", 2)]);
    expect(out.every((n) => n.reply === undefined)).toBe(true);
  });

  it("matches a Gossamr reply (mention, quote, answer) to the comment it quotes", () => {
    const doc = { blocks: [mention("Sam Holt"), Q("Ready for another look, retries now cap at five."), P("On it.")] };
    const [, reply] = withReplies([original, replyNote("r", "Ida", doc, 2)]);
    expect(reply.reply).toMatchObject({ replyingTo: "Sam Holt", targetId: "a", quote: "Ready for another look, retries now cap at five." });
    expect(ownText(reply)).toBe("On it.");
  });

  it("recognises a quote-first comment, as Jira's own quote feature writes it, and a truncated excerpt", () => {
    const doc = { blocks: [Q("Ready for another look, retries now…"), P("Looks fine.")] };
    const [, reply] = withReplies([original, replyNote("r", "Ida", doc, 2)]);
    expect(reply.reply).toMatchObject({ replyingTo: "Sam Holt", targetId: "a" });
  });

  it("prefers the mentioned author and an earlier comment when several start with the same text", () => {
    const a = plain("a", "Sam Holt", "Same text here", 1);
    const b = plain("b", "Ida Pedersen", "Same text here", 2);
    const doc = { blocks: [mention("Sam Holt"), Q("Same text here"), P("ok")] };
    const out = withReplies([a, b, replyNote("r", "Jonas", doc, 3)]);
    expect(out[2].reply?.targetId).toBe("a");
    const noMention = withReplies([a, b, replyNote("r", "Jonas", { blocks: [Q("Same text here"), P("ok")] }, 3)]);
    expect(noMention[2].reply?.targetId).toBe("b");
  });

  it("is still a reply when nothing matches, naming the mentioned person or nobody", () => {
    const withName = withReplies([replyNote("r", "Ida", { blocks: [mention("Sam Holt"), Q("gone"), P("hm")] }, 2)]);
    expect(withName[0].reply).toMatchObject({ replyingTo: "Sam Holt", targetId: null });
    const anon = withReplies([replyNote("r", "Ida", { blocks: [Q("gone"), P("hm")] }, 2)]);
    expect(anon[0].reply).toMatchObject({ replyingTo: null, targetId: null });
  });

  it("does not link to a comment that comes later in the list", () => {
    const later = plain("z", "Sam Holt", "Quoted text", 9);
    const out = withReplies([replyNote("r", "Ida", { blocks: [Q("Quoted text"), P("x")] }, 2), later]);
    expect(out[0].reply).toMatchObject({ replyingTo: "Sam Holt", targetId: null });
  });

  it("matches a reply to a reply by what the author wrote below the quote", () => {
    const first = replyNote("r1", "Ida", { blocks: [mention("Sam Holt"), Q("Ready for another look"), P("Will do tomorrow")] }, 2);
    const second = replyNote("r2", "Jonas", { blocks: [mention("Ida"), Q("Will do tomorrow"), P("Great")] }, 3);
    const out = withReplies([original, first, second]);
    expect(out[2].reply?.targetId).toBe("r1");
  });

  it("does not treat a quote in the middle of a comment as a reply", () => {
    const n = replyNote("r", "Ida", { blocks: [P("As discussed:"), Q("Ready"), P("yes")] }, 2);
    expect(withReplies([original, n])[1].reply).toBeUndefined();
  });

  it("copes with empty quotes and comments without a structured body", () => {
    expect(() => withReplies([{ id: "x", who: "A", at: "2026-09-01T10:00:00Z", text: "plain" }, replyNote("r", "B", { blocks: [Q("")] }, 2)])).not.toThrow();
  });
});

describe("replyDraft", () => {
  it("starts with an @mention of the author on its own line and a quoted excerpt of the original", () => {
    const d = replyDraft(plain("a", "Sam Holt", "x".repeat(300)));
    expect(d.text).toBe("@Sam Holt\n\n");
    expect(d.mentions).toEqual([{ accountId: "sam holt", name: "Sam Holt" }]);
    expect(d.quote.length).toBe(EXCERPT_LENGTH + 1);
    expect(d.to).toEqual({ id: "a", who: "Sam Holt" });
  });

  it("quotes the text below the quote when answering a reply", () => {
    const [, r] = withReplies([plain("a", "Sam", "Orig"), replyNote("r", "Ida", { blocks: [Q("Orig"), P("My answer")] }, 2)]);
    expect(replyDraft(r).quote).toBe("My answer");
  });

  it("quotes without mentioning someone whose name is not known", () => {
    const d = replyDraft({ ...plain("a", "Someone", "hi"), accountId: "557058:abc" });
    expect(d.text).toBe("");
    expect(d.mentions).toEqual([]);
    expect(d.quote).toBe("hi");
  });
});

describe("quoteAfterFirst", () => {
  it("puts the quote after the first paragraph, or alone for an empty doc", () => {
    const doc = quoteAfterFirst({ blocks: [mention("Sam"), P("answer")] }, "orig");
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "quote", "paragraph"]);
    expect(quoteAfterFirst({ blocks: [] }, "orig").blocks.map((b) => b.type)).toEqual(["quote"]);
  });
});

describe("styling", () => {
  const cardMarkup = (note: Note) => renderToStaticMarkup(<CommentCard note={note} now={NOW} onReply={() => {}} onShow={() => {}} />);
  const card = (out: string) => /<li[^>]*class="([^"]*)"/.exec(out)![1];

  it("gives ordinary comments, including your own, no accent border", () => {
    for (const mine of [false, true]) {
      const cls = card(cardMarkup({ ...plain("a", "Sam Holt", "Hello"), mine }));
      expect(cls).not.toMatch(/border-l/);
      expect(cls).not.toContain("accent-soft");
    }
  });

  it("marks you with small accent text rather than a filled pill", () => {
    const out = cardMarkup({ ...plain("a", "Alf", "Hello"), mine: true });
    expect(out).toMatch(/<span class="shrink-0 text-xs font-semibold text-ws-accent">you<\/span>/);
  });

  it("draws one muted 2px line on a reply, and says who it answers", () => {
    const [, reply] = withReplies([plain("a", "Sam Holt", "Orig text"), replyNote("r", "Ida", { blocks: [mention("Sam Holt"), Q("Orig text"), P("Agreed")] }, 2)]);
    const out = cardMarkup(reply);
    expect(card(out).match(/border-l-\S+/g)).toEqual(["border-l-2", "border-l-ws-accent/50"]);
    expect(out).toContain("replying to");
    expect(out).toContain("Sam Holt");
    expect(out).toContain("Agreed");
    expect(out).toContain("line-clamp-2");
    expect(out).toContain('data-reply="true"');
    expect(out).not.toContain("Show more");
  });

  it("links a reply back to an earlier comment and only offers expanding a long quote", () => {
    const long = "word ".repeat(40).trim();
    const [, reply] = withReplies([plain("a", "Sam", long), replyNote("r", "Ida", { blocks: [Q(long), P("Agreed")] }, 2)]);
    const out = cardMarkup(reply);
    expect(out).toContain('title="Show the comment this answers"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("Show more");
    const orphan = renderToStaticMarkup(<CommentCard note={{ ...reply, reply: { ...reply.reply!, targetId: null } }} now={NOW} />);
    expect(orphan).not.toContain("Show the comment this answers");
  });

  it("offers Reply with a keyboard hint in its tooltip only, revealed on hover and focus", () => {
    const out = cardMarkup(plain("a", "Sam Holt", "Hello"));
    expect(out).toContain('aria-label="Reply to Sam Holt"');
    expect(out).toMatch(/title="Reply to Sam Holt \(press R on this comment\)"/);
    expect(out).toContain("group-hover:opacity-100");
    expect(out).toContain("group-focus-within:opacity-100");
    expect(renderToStaticMarkup(<CommentCard note={plain("a", "Sam", "Hi")} now={NOW} />)).not.toContain("Reply");
  });

  it("wraps long unbroken text in a reply", () => {
    const url = "https://example.com/" + "a".repeat(200);
    const [, reply] = withReplies([plain("a", "Sam", url), replyNote("r", "Ida", { blocks: [Q(url), P(url)] }, 2)]);
    const out = cardMarkup(reply);
    expect(out.match(/\[overflow-wrap:anywhere\]/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the comments section card plain: no accent border or tinted body", () => {
    const out = renderToStaticMarkup(<SectionCard id="comments" title="Comments" count={3} tone="discussion">x</SectionCard>);
    expect(out).not.toMatch(/border-l/);
    expect(out).not.toContain("bg-ws-bar/60");
    expect(out).not.toContain("linear-gradient");
    expect(out).toMatch(/bg-ws-accent-soft[^"]*">3</);
  });
});

describe("the sample ticket", () => {
  it("has replies on DEVOPS-471 that match the comments they answer", async () => {
    const b = new MockBackend();
    const comments = await b.cacheComments(itemRef("DEVOPS-471"));
    const notes = withReplies(
      comments.map((c) => ({ id: c.id, at: c.created, who: c.author.accountId, text: docText(c.body), doc: c.body })).sort((x, y) => x.at.localeCompare(y.at)),
    );
    const replies = notes.filter((n) => n.reply);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(replies.every((n) => n.reply!.targetId !== null)).toBe(true);
  });

  it("posts an approved reply with its quote intact", async () => {
    const b = new MockBackend();
    const draft = await b.proposalsCreate({ type: "comment", item: itemRef("DEVOPS-471"), body: { blocks: [P("@Sam")] } });
    const edited = await b.proposalsEdit(draft.id, { type: "comment", body: "@Sam\n\nThanks", mentions: [], quote: "Ready for another look" });
    expect(edited.intent.type === "comment" && edited.intent.body.blocks.map((x) => x.type)).toEqual(["paragraph", "quote", "paragraph"]);
  });
});

describe("newestFirst", () => {
  it("lists the latest comment first, after replies have been matched to what they answer", () => {
    const first = plain("a", "Sam Holt", "Ready for another look, retries now cap at five.", 1);
    const reply = replyNote("r", "Ida", { blocks: [mention("Sam Holt"), Q("Ready for another look, retries now cap at five."), P("On it.")] }, 2);
    const last = plain("c", "Kim", "Merged.", 3);
    const shown = newestFirst(withReplies([first, reply, last]));
    expect(shown.map((n) => n.id)).toEqual(["c", "r", "a"]);
    expect(shown[1].reply?.targetId).toBe("a");
  });
});

describe("shownComments", () => {
  const person = { connectionId: "c", accountId: "sam" };
  const loaded = (id: string, text: string, min: number): WorkComment => ({ id, author: person, body: { blocks: [P(text)] }, created: `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`, mentions: [] });
  const event = (id: string, text: string, min: number): WorkEvent => ({
    id,
    connectionId: "c",
    at: `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`,
    kind: "commentAdded",
    subject: { type: "item", item: itemRef("DEVOPS-471") },
    actor: person,
    payload: { text },
  });
  const nameOf = (id: string | null) => id ?? "Someone";

  it("lists loaded comments newest first, whatever order they arrive in", () => {
    const shown = shownComments([loaded("b", "second", 2), loaded("a", "first", 1), loaded("c", "third", 3)], [], nameOf, () => false);
    expect(shown.map((n) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("lists the comments the events recorded newest first while the loaded ones are not there yet", () => {
    const shown = shownComments(undefined, [event("e1", "first", 1), event("e2", "second", 2)], nameOf, () => false);
    expect(shown.map((n) => n.text)).toEqual(["second", "first"]);
  });
});
