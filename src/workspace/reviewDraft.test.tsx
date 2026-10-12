import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoHeight } from "../components/autoHeight";
import { hunkLinesAround } from "../lib/diffHunks";
import { REVIEW_NOT_FOUND_NOTE, REVIEW_OUTDATED_NOTE } from "../lib/proposals";
import type { Proposal, ReviewAccess } from "../types";
import { DraftCard, type DraftCardProps } from "./DraftCard";
import { docFromText } from "../lib/docs";
import { draftPreviewBody } from "./DraftPreview";
import { usePullView, type PullDiffState } from "./pullViewStore";
import { sample } from "./reviewSample";
import { scriptPip } from "../backend/mockPip";
import type { ScreenContext } from "../types";
import { editThenPost, editThenPullView, settlesEdit, followDraft, hasMarkdown, keptOlderNote, SUMMARY, MARKDOWN_HINT, postedLine, postedWith, postLabel, postsWhat, pullViewOf, ReviewDraft, reviewEdit, ReviewHunk, reviewWithPipPrompt, toggleDropped, type Held } from "./ReviewDraft";

vi.mock("../components/autoHeight", async (original) => ({ ...(await original<typeof import("../components/autoHeight")>()), useAutoHeight: vi.fn() }));

const RETRY = "src/consumer/retry.ts";
const at = (line: number, body: string) => ({ path: RETRY, line, side: "RIGHT" as const, body });
const intent = { type: "githubReview" as const, connectionId: "github:sample", item: null, runId: "run-1", repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6", summary: "Gossamr review of #218 at a1b2c3d4: blocking.", comments: [at(42, "**Blocking:** the retry loop never backs off."), at(17, "**Nit:** name it MAX_ATTEMPTS.")] };

const draft = (over: Partial<Proposal> = {}): Proposal => ({
  id: "r1",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  origin: { type: "run", runId: "run-1", shortId: "abcd1234" },
  createdBy: "agent",
  intent,
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const canPost: ReviewAccess = { canPost: true, reason: null };
const cantPost: ReviewAccess = { canPost: false, reason: "This GitHub token can't post reviews on acme/webshop (it lacks write access to its pull requests)." };

const render = (p: Proposal, access: ReviewAccess | null, diff: PullDiffState = sample(), initial?: { summary: string; comments: Held[] }) =>
  renderToStaticMarkup(<ReviewDraft proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} access={access} diff={diff} initial={initial} />);

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
afterEach(() => {
  vi.unstubAllGlobals();
  usePullView.setState({ target: null, opener: null });
});

/** The static markup of a draft card's action bar, and whatever the card renders after it. */
function actionBarOf(html: string): { bar: string; after: string } {
  const start = html.lastIndexOf("<div data-draft-actions");
  if (start < 0) return { bar: "", after: html };
  let depth = 0;
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { bar: html.slice(start, tag.lastIndex), after: html.slice(tag.lastIndex) };
  }
  return { bar: html.slice(start), after: "" };
}

/** The bar is pinned to the bottom of its card, opaque, with a rule above it, and nothing of the card comes after it. */
function expectPinnedBar(html: string) {
  const { bar, after } = actionBarOf(html);
  const open = bar.slice(0, bar.indexOf(">") + 1);
  for (const cls of ["sticky", "bottom-0", "bg-ws-win", "border-t"]) expect(open).toMatch(new RegExp(`class="[^"]*(?<![\\w-])${cls}(?![\\w-])`));
  // Only the closing tags of the card's body and the card itself follow the bar.
  expect(after).toBe("</div></article>");
}

describe("a GitHub review draft's preview", () => {
  it("shows the summary exactly as it will be posted, its last line included", () => {
    const summary = "Not ready yet.\n\nDrafted by a Gossamr agent reviewing CA-402; posted only after a person approved it in Gossamr.";
    const body = draftPreviewBody(draft({ intent: { ...intent, summary } }), null);
    expect(body.startsWith(`${summary}\n\n`)).toBe(true);
  });
});

describe("a GitHub review draft's card", () => {
  it("shows the hunk around each comment with its line marked, under a path:line heading, with an editable body", () => {
    const html = render(draft(), canPost);
    expect(html).toContain('aria-label="GitHub review of acme/webshop#218"');
    expect(html).toContain("acme/webshop#218");
    expect(html).toMatch(/data-review-commit[^>]*>a1b2c3d4</);
    // No ticket and no run known here: the run is named plainly, never by its id.
    expect(html).toContain("From <b>an agent run</b>");
    expect(html).not.toContain("abcd1234");
    for (const line of [42, 17]) {
      expect(html).toContain(`data-review-comment="${RETRY}:${line}"`);
      expect(html).toContain(`aria-label="Comment on ${RETRY}:${line}"`);
      expect(html).toContain(`aria-label="Drop comment on ${RETRY}:${line}"`);
    }
    expect(html.match(/data-review-hunk/g)).toHaveLength(2);
    // Each comment's own line is the marked one.
    expect(html).toMatch(/data-hunk-target=""[^>]*>(?:(?!<\/div>).)*42<\/span><span class="min-w-0 pr-2 whitespace-pre-wrap \[overflow-wrap:anywhere\]">\+ {4}try \{ return await handle\(message\); \} catch \{ continue; \}<\/span>/);
    expect(html).toMatch(/data-hunk-target=""[^>]*>(?:(?!<\/div>).)*17<\/span><span class="min-w-0 pr-2 whitespace-pre-wrap \[overflow-wrap:anywhere\]">\+const MAX = 5;<\/span>/);
    expect(html).toMatch(/<textarea id="review-summary-r1"[^>]*>Gossamr review of #218 at a1b2c3d4: blocking.<\/textarea>/);
    expect(html).toMatch(/<button[^>]*>Post review \(2 comments\)<\/button>/);
    expect(html).toMatch(/<button[^>]*>Discard<\/button>/);
    expect(html).toMatch(/<button[^>]*>Open PR view<\/button>/);
    expect(html).not.toContain("data-review-moved");
  });

  it("renders a hunk as the unified lines around the target, numbered on its side", () => {
    const state = sample();
    const file = state.status === "ready" ? state.diff.files[0] : null;
    const around = hunkLinesAround(file!.patch!, 42, "RIGHT", 2)!;
    expect(around.lines.map((l) => [l.right, l.raw])).toEqual([
      [40, "+  while (attempt < MAX) {"],
      [41, "+    attempt += 1;"],
      [42, "+    try { return await handle(message); } catch { continue; }"],
      [43, "+  }"],
      [44, '   throw new Error("gave up");'],
    ]);
    expect(around.at).toBe(2);
    // Within its hunk only: the deleted line just above has no number on the new side, and the hunk ends after 45.
    expect(hunkLinesAround(file!.patch!, 42, "RIGHT")!.lines.map((l) => l.right)).toEqual([null, 40, 41, 42, 43, 44, 45]);
    const html = renderToStaticMarkup(<ReviewHunk file={file} line={42} side="RIGHT" />);
    // The card shows two lines either side, so the first comment's box fits under the summary in the peek (D21).
    expect(html.match(/data-hunk-line=/g)).toHaveLength(5);
    expect(html.match(/data-hunk-target/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<ReviewHunk file={file} line={30} side="RIGHT" />)).toContain("doesn&#x27;t show this line now");
    expect(renderToStaticMarkup(<ReviewHunk file={undefined} line={42} side="RIGHT" />)).toContain("isn&#x27;t in the pull request&#x27;s diff now");
  });

  it("drops and restores a comment, and a dropped one shows as dropped with Restore until the edit is sent", () => {
    const start: Held[] = intent.comments.map((c) => ({ ...c, dropped: false }));
    const dropped = toggleDropped(start, 1);
    expect(dropped.map((c) => c.dropped)).toEqual([false, true]);
    expect(toggleDropped(dropped, 1)).toEqual(start);
    expect(reviewEdit(intent, intent.summary, toggleDropped(dropped, 1))).toBeNull();
    const html = render(draft(), canPost, sample(), { summary: intent.summary, comments: dropped });
    expect(html).toContain(`data-review-dropped="${RETRY}:17"`);
    expect(html).not.toContain(`data-review-comment="${RETRY}:17"`);
    expect(html).toContain(`aria-label="Restore comment on ${RETRY}:17"`);
    expect(html).not.toContain(`aria-label="Comment on ${RETRY}:17"`);
  });

  it("sends only what changed as the person's edit, then posts", async () => {
    const reworded = [{ ...at(42, " Please add a backoff. "), dropped: false }, { ...intent.comments[1], dropped: true }];
    const edit = reviewEdit(intent, intent.summary, reworded);
    expect(edit).toEqual({ type: "githubReview", comments: [at(42, "Please add a backoff.")] });
    expect(reviewEdit(intent, " New summary ", intent.comments.map((c) => ({ ...c, dropped: false })))).toEqual({ type: "githubReview", summary: "New summary" });
    const calls: string[] = [];
    const posted = await editThenPost("r1", edit, 2, {
      saveEdit: async (id, e) => void calls.push(`edit ${id} ${JSON.stringify(e)}`),
      post: async (id, revisions) => (calls.push(`post ${id} at ${revisions}`), "posted"),
    });
    expect(posted).toBe("posted");
    // The edit is the one revision more than the card showed that the post may find.
    expect(calls).toEqual([`edit r1 ${JSON.stringify(edit)}`, "post r1 at 3"]);
    const plain: string[] = [];
    await editThenPost("r1", null, 2, { saveEdit: async () => void plain.push("edit"), post: async (_, revisions) => void plain.push(`post at ${revisions}`) });
    expect(plain).toEqual(["post at 2"]);
    const refused: string[] = [];
    await expect(editThenPost("r1", edit, 0, { saveEdit: async () => Promise.reject(new Error("an edit can't move a comment")), post: async () => void refused.push("post") })).rejects.toThrow("can't move");
    expect(refused).toEqual([]);
  });

  it("follows a draft Pip changed under the person's unsaved edit: their words stay on the comments it still has", () => {
    const typed: Held[] = [{ ...intent.comments[0], dropped: false }, { ...at(17, "My words on the nit."), dropped: false }];
    const dropped = { ...intent, comments: [intent.comments[1], at(3, "**Nit:** a new one.")] };
    const next = followDraft(intent, dropped, intent.summary, typed);
    expect(next.comments).toEqual([{ ...at(17, "My words on the nit."), dropped: false }, { ...at(3, "**Nit:** a new one."), dropped: false }]);
    // What the card holds is then an edit of the draft as it is now, with nothing moved or added.
    expect(reviewEdit(dropped, next.summary, next.comments)).toEqual({ type: "githubReview", comments: [at(17, "My words on the nit."), at(3, "**Nit:** a new one.")] });
    const reworded = followDraft(intent, { ...intent, summary: "Pip's summary.", comments: [at(42, "Pip's words.")] }, "My summary.", [{ ...intent.comments[0], dropped: true }, { ...intent.comments[1], dropped: false }]);
    expect(reworded).toEqual({ summary: "My summary.", comments: [{ ...at(42, "**Blocking:** the retry loop never backs off."), dropped: true }] });
    // Untouched, Pip's version is taken whole.
    expect(followDraft(intent, { ...intent, summary: "Pip's summary.", comments: [at(42, "Pip's words.")] }, intent.summary, intent.comments.map((c) => ({ ...c, dropped: false })))).toEqual({ summary: "Pip's summary.", comments: [{ ...at(42, "Pip's words."), dropped: false }] });
  });

  it("keeps what the person typed back during a save, even when it matches the draft before the save", () => {
    // The card saved summary B and comment 42 as B; while the save was on its way the person typed both back to A.
    const saved = { ...intent, summary: "B summary.", comments: [at(42, "B words."), intent.comments[1]] };
    const back = intent.comments.map((c) => ({ ...c, dropped: false }));
    const kept = followDraft(intent, saved, intent.summary, back, new Set([SUMMARY, `${intent.comments[0].path}:42:${intent.comments[0].side}`]));
    expect(kept).toEqual({ summary: intent.summary, comments: back });
    // Without the save's touched fields, the same values would read as untouched and take the saved draft.
    expect(followDraft(intent, saved, intent.summary, back).summary).toBe("B summary.");
  });

  it("marks a draft the person edited, and says when a revision was Pip's", () => {
    const edited = render(draft({ revisions: [{ at: "2026-10-01T10:05:00Z", note: "Edited", intent }] }), canPost);
    expect(edited).toMatch(/data-review-edited[^>]*>Edited</);
    const revised = render(draft({ revisions: [{ at: "2026-10-01T10:05:00Z", note: "Revised by Pip", intent }] }), canPost);
    expect(revised).not.toContain("data-review-edited");
    expect(revised).toMatch(/data-review-revision[^>]*>Revised by Pip</);
  });

  it("warns when the pull request's head moved since the review, and shows Outdated once GitHub refused it", () => {
    const html = render(draft(), canPost, sample("b2b2c3c3d4d4e5e5"));
    expect(html).toContain("The pull request has moved on since this review: reviewed a1b2c3d4, now at b2b2c3c3. GitHub may mark these comments outdated.");
    expect(render(draft(), canPost, sample("a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"))).not.toContain("data-review-moved");
    const outdated = render(draft({ error: REVIEW_OUTDATED_NOTE }), canPost, sample("b2b2c3c3d4d4"));
    expect(outdated).toMatch(/data-review-outdated[^>]*>Outdated</);
    expect(outdated).toMatch(/role="alert"[^>]*>GitHub says this review&#x27;s lines no longer match/);
  });

  it("says a review may already be on GitHub, and offers Post anyway only once Gossamr looked and didn't find it", () => {
    const sent = { at: "2026-10-01T10:01:00Z", commitSha: "a1b2c3d4e5f6", summary: intent.summary, checkedAt: null };
    const unsure = render(draft({ maybePosted: sent }), canPost);
    expect(unsure).toMatch(/data-review-maybe-posted[^>]*>This review may already be on GitHub: Gossamr sent it at a1b2c3d4/);
    expect(unsure).not.toContain("Post anyway");
    expect(unsure).toMatch(/<button[^>]*>Post review \(2 comments\)<\/button>/);
    const checked = render(draft({ maybePosted: { ...sent, checkedAt: "2026-10-01T10:02:00Z" }, error: REVIEW_NOT_FOUND_NOTE }), canPost);
    expect(checked).toMatch(/<button[^>]*data-review-post-anyway[^>]*>Post anyway<\/button>/);
    expect(checked).toContain("If it isn&#x27;t there, Post anyway sends it.");
    expect(render(draft({ maybePosted: { ...sent, checkedAt: "2026-10-01T10:02:00Z" } }), cantPost)).not.toContain("Post anyway");
    expect(render(draft(), canPost)).not.toContain("data-review-maybe-posted");
  });

  it("with a token that can't post, has no Post review, says why, and its Open PR view opens the pull request view with this draft", () => {
    const html = render(draft(), cantPost);
    expect(html).not.toContain(">Post review<");
    expect(html).toContain("This GitHub token can&#x27;t post reviews on acme/webshop (it lacks write access to its pull requests).");
    expect(html).toMatch(/<button[^>]*>Open PR view<\/button>/);
    const open = vi.spyOn(usePullView.getState(), "open");
    usePullView.setState({ open });
    pullViewOf(draft())();
    expect(open).toHaveBeenCalledWith({ connectionId: "github:sample", repo: "acme/webshop", number: 218, proposalId: "r1" });
    expect(usePullView.getState().target).toEqual({ connectionId: "github:sample", repo: "acme/webshop", number: 218, proposalId: "r1" });
  });

  it("offers Discuss with Pip, which asks about this draft by its id and only to change it when asked", () => {
    const discuss = vi.fn();
    const html = renderToStaticMarkup(<ReviewDraft proposal={draft()} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onDiscuss={discuss} access={canPost} diff={sample()} />);
    expect(html).toMatch(/<button[^>]*>Discuss with Pip<\/button>/);
    expect(render(draft({ state: { type: "applied" } }), canPost)).not.toContain("Discuss with Pip");
    const prompt = reviewWithPipPrompt(draft());
    expect(prompt).toContain("GitHub review draft r1 of acme/webshop#218, drafted from agent run run-1.");
    expect(prompt).toContain("get_proposal");
    expect(prompt).toContain("list_review_comments");
    expect(prompt).toContain("Revise the draft only if I ask you to");
    // The sample Pip reads it as a talk about this draft and changes nothing yet.
    const reply = scriptPip(prompt, { view: null, item: null, filter: null, selection: [] } as unknown as ScreenContext, [], [], Date.now(), [draft()]);
    expect([reply.discussed, reply.revise ?? null]).toEqual(["r1", null]);
  });

  it("ends a comment's and a move's card with the action bar too, pinned and solid, an error above it", () => {
    const comment = { type: "comment", item: { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" }, body: docFromText("Looks good.") } as const;
    const plain = (over: Partial<Proposal>, props: Partial<DraftCardProps> = {}) =>
      renderToStaticMarkup(<DraftCard proposal={draft({ origin: { type: "chat", requestId: "r" }, createdBy: "pip", ...over })} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} {...props} />);
    expectPinnedBar(plain({ intent: comment }, { onShow: vi.fn() }));
    expectPinnedBar(plain({ intent: { type: "transition", item: comment.item, to: "done" }, label: "Done" }, { statusName: "Done", error: "It failed." }));
  });

  it("ends the card with its action bar, pinned to the bottom, opaque and ruled off, notes and errors above it", () => {
    expectPinnedBar(render(draft(), canPost));
    expectPinnedBar(renderToStaticMarkup(<ReviewDraft proposal={draft()} statusName={null} people={[]} working={false} error="GitHub said no." onApprove={vi.fn()} onSkip={vi.fn()} access={cantPost} diff={sample()} />));
  });

  it("is the card DraftCard shows for a GitHub review", () => {
    const html = renderToStaticMarkup(<DraftCard proposal={draft()} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} access={canPost} />);
    expect(html).toContain("data-github-review");
    expect(html).toContain("Loading the diff…");
    expect(html).toMatch(/<button[^>]*>Post review \(2 comments\)<\/button>/);
  });
});

describe("a GitHub review draft's card in the peek (D9, D20, D21, D32)", () => {
  it("Open PR view saves the person's unsent edit first, takes it into the store, and only then opens the view", async () => {
    const order: string[] = [];
    const saved = draft({ intent: { ...intent, summary: "My words." }, revisions: [{ at: "2026-10-01T10:01:00Z", note: "Edited" }] as Proposal["revisions"] });
    const saveEdit = vi.fn(async () => (order.push("save"), saved));
    const took = vi.fn(() => order.push("took"));
    const open = vi.fn(() => order.push("open"));
    await editThenPullView(draft(), { type: "githubReview", summary: "My words." }, { saveEdit, took, open });
    expect(saveEdit).toHaveBeenCalledWith("r1", { type: "githubReview", summary: "My words." });
    expect(took).toHaveBeenCalledWith(saved);
    expect(order).toEqual(["save", "took", "open"]);
    // With nothing edited, it only opens.
    order.length = 0;
    await editThenPullView(draft(), null, { saveEdit, took, open });
    expect(order).toEqual(["open"]);
    // A refused edit opens nothing, so the view never shows words the card doesn't.
    order.length = 0;
    await expect(editThenPullView(draft(), { type: "githubReview", summary: "" }, { saveEdit: () => Promise.reject(new Error("no")), took, open })).rejects.toThrow("no");
    expect(order).toEqual([]);
    // Text typed while the save was on its way stays an unsent edit, so the saved draft arriving can't overwrite it.
    expect(settlesEdit(3, 3)).toBe(true);
    expect(settlesEdit(3, 4)).toBe(false);
  });

  it("says beside Post that it posts the inline comments and the summary as a comment review, never a verdict", () => {
    expect(postsWhat(2)).toBe("Posts 2 inline comments and the summary as a comment review (not Approve or Request changes), at the reviewed commit.");
    expect(postsWhat(1)).toBe("Posts 1 inline comment and the summary as a comment review (not Approve or Request changes), at the reviewed commit.");
    expect(postsWhat(0)).toBe("Posts the summary as a comment review (not Approve or Request changes), at the reviewed commit.");
    expect(render(draft(), canPost)).toContain(`data-review-posts="true" class="m-0 text-sm text-ws-ink3">${postsWhat(2).replace(/'/g, "&#x27;")} Nothing goes to GitHub until you post it here.`);
    // A dropped comment isn't counted.
    const one = render(draft(), canPost, sample(), { summary: intent.summary, comments: intent.comments.map((c, i) => ({ ...c, dropped: i === 1 })) });
    expect(one).toContain(postsWhat(1));
  });

  it("notes under the text boxes that their words are Markdown that GitHub formats, and ties each box to the note", () => {
    const html = render(draft(), canPost);
    expect(MARKDOWN_HINT).toBe("Markdown, formatted on GitHub");
    expect(html).toContain(`<p id="review-markdown-r1" data-review-markdown="true" class="m-0 text-xs text-ws-ink3">${MARKDOWN_HINT}</p>`);
    expect(html.match(/<textarea[^>]*aria-describedby="review-markdown-r1"/g)).toHaveLength(3);
    // Once posted there is nothing to type, and no note.
    expect(render(draft({ state: { type: "applied" } }), canPost)).not.toContain("data-review-markdown");
  });

  it("once posted, says where and at which commit it went instead of the before-you-post advice (N5)", () => {
    const pending = render(draft(), canPost);
    expect(pending).toContain("read and edit it before you post");
    expect(pending).toContain("Nothing goes to GitHub until you post it here.");
    const posted = render(draft({ state: { type: "applied" } }), canPost);
    expect(posted).not.toContain("read and edit it before you post");
    expect(posted).not.toContain("Nothing goes to GitHub until you post it here.");
    expect(posted).toContain("Posted to acme/webshop#218 at a1b2c3d4, as a comment review.");
    expect(postedLine("skipped", intent)).toBe(". Discarded: nothing went to GitHub.");
  });

  it("grows each text box with its words, and wraps long diff lines rather than cut them off", () => {
    vi.mocked(useAutoHeight).mockClear();
    const long = "**Nit:** " + "this sentence goes on. ".repeat(20);
    const html = render(draft({ intent: { ...intent, comments: [at(42, long), at(17, "Short.")] } }), canPost);
    expect(vi.mocked(useAutoHeight).mock.calls.map(([, value]) => value)).toEqual([intent.summary, long, "Short."]);
    expect(html.match(/<textarea[^>]*class="[^"]*resize-none/g)).toHaveLength(3);
    // A box scrolled into view keeps clear of the pinned action bar.
    expect(html.match(/<textarea[^>]*class="[^"]*scroll-mb-16/g)).toHaveLength(3);
    expect(html).not.toMatch(/data-hunk-line="[^"]*" class="flex whitespace-pre /);
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain("whitespace-pre-wrap [overflow-wrap:anywhere]");
  });
});

describe("an older review of the same pull request left standing", () => {
  const older = (over: Partial<Proposal> = {}) => draft({ id: "old", createdAt: "2026-10-01T09:00:00Z", origin: { type: "run", runId: "run-0", shortId: null }, intent: { ...intent, runId: "run-0" }, ...over });
  const edited = older({ revisions: [{ at: "2026-10-01T09:30:00Z", note: "Edited", intent: { ...intent, runId: "run-0", summary: "Mine." } }] });
  const at = (p: Proposal, all: Proposal[]) => renderToStaticMarkup(<ReviewDraft proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} access={canPost} diff={sample()} drafts={all} />);

  it("says on the newer card that one the person edited is still waiting", () => {
    expect(keptOlderNote(draft(), [edited, draft()])).toBe("An older review of #218 that you edited is still waiting; this one didn't replace it.");
    expect(at(draft(), [edited, draft()])).toContain("An older review of #218 that you edited is still waiting; this one didn&#x27;t replace it.");
    // Not on the older card itself, nor for one the newer review replaced or that was posted.
    expect(at(edited, [edited, draft()])).not.toContain("data-review-kept-older");
    expect(at(draft(), [older({ state: { type: "retired", reason: "Replaced by a newer draft" } }), draft()])).not.toContain("data-review-kept-older");
    expect(at(draft(), [older({ state: { type: "applied" } }), draft()])).not.toContain("data-review-kept-older");
  });

  it("says so for one GitHub may have already", () => {
    const unsure = older({ maybePosted: { at: "2026-10-01T09:40:00Z", commitSha: "a1b2c3d4e5f6", summary: "S.", checkedAt: null } });
    expect(keptOlderNote(draft(), [unsure, draft()])).toBe("An older review of #218 that may already be on GitHub is still waiting; this one didn't replace it.");
  });

  it("says on the Post review button how many inline comments it sends, and on a posted card how many went out (R13)", () => {
    expect(postLabel(0)).toBe("Post review");
    expect(postLabel(1)).toBe("Post review (1 comment)");
    expect(postLabel(3)).toBe("Post review (3 comments)");
    expect(postedWith(0)).toBeNull();
    expect(postedWith(2)).toBe("Posted with 2 comments");
    expect(render(draft(), canPost)).not.toContain("data-review-posted-with");
    expect(render(draft({ state: { type: "applied" } }), canPost)).toMatch(/data-review-posted-with[^>]*>Posted with 2 comments</);
  });
});

describe("the Markdown preview under the review's text boxes", () => {
  it("is shown for words with Markdown in them and left out for plain words", () => {
    expect(hasMarkdown("**Nit:** name it MAX_ATTEMPTS.")).toBe(true);
    expect(hasMarkdown("- one\n- two")).toBe(true);
    expect(hasMarkdown("Gossamr review of #218 at a1b2c3d4: blocking.")).toBe(false);
  });

  it("renders each comment's Markdown read-only beneath its textarea, which still holds the raw words", () => {
    const html = render(draft(), canPost);
    expect(html.match(/data-review-preview/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Preview of the comment on src/consumer/retry.ts:42"');
    expect(html).toContain('<b class="font-semibold">Blocking:</b> the retry loop never backs off.');
    expect(html).toContain("**Blocking:** the retry loop never backs off.</textarea>");
  });

  it("previews an edited summary, and renders the words of a draft that is no longer open", () => {
    const edited = render(draft(), canPost, sample(), { summary: "Needs a **back-off**.", comments: [] });
    expect(edited).toContain('aria-label="Preview of the review summary"');
    const posted = render(draft({ state: { type: "applied" } }), null);
    expect(posted).not.toContain("data-review-preview");
    expect(posted).toContain('<b class="font-semibold">Blocking:</b>');
    expect(posted).not.toContain("**Blocking:**");
  });
});
