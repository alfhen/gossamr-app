import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hunkLinesAround } from "../lib/diffHunks";
import { REVIEW_OUTDATED_NOTE } from "../lib/proposals";
import type { Proposal, ReviewAccess } from "../types";
import { DraftCard } from "./DraftCard";
import { usePullView, type PullDiffState } from "./pullViewStore";
import { sample } from "./reviewSample";
import { scriptPip } from "../backend/mockPip";
import type { ScreenContext } from "../types";
import { editThenPost, followDraft, pullViewOf, ReviewDraft, reviewEdit, ReviewHunk, reviewWithPipPrompt, toggleDropped, type Held } from "./ReviewDraft";

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

describe("a GitHub review draft's card", () => {
  it("shows the hunk around each comment with its line marked, under a path:line heading, with an editable body", () => {
    const html = render(draft(), canPost);
    expect(html).toContain('aria-label="GitHub review of acme/webshop#218"');
    expect(html).toContain("acme/webshop#218");
    expect(html).toMatch(/data-review-commit[^>]*>a1b2c3d4</);
    expect(html).toContain("From agent run");
    for (const line of [42, 17]) {
      expect(html).toContain(`data-review-comment="${RETRY}:${line}"`);
      expect(html).toContain(`aria-label="Comment on ${RETRY}:${line}"`);
      expect(html).toContain(`aria-label="Drop comment on ${RETRY}:${line}"`);
    }
    expect(html.match(/data-review-hunk/g)).toHaveLength(2);
    // Each comment's own line is the marked one.
    expect(html).toMatch(/data-hunk-target=""[^>]*>(?:(?!<\/div>).)*42<\/span><span class="pr-2">\+ {4}try \{ return await handle\(message\); \} catch \{ continue; \}<\/span>/);
    expect(html).toMatch(/data-hunk-target=""[^>]*>(?:(?!<\/div>).)*17<\/span><span class="pr-2">\+const MAX = 5;<\/span>/);
    expect(html).toMatch(/<textarea id="review-summary-r1"[^>]*>Gossamr review of #218 at a1b2c3d4: blocking.<\/textarea>/);
    expect(html).toMatch(/<button[^>]*>Post review<\/button>/);
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
    expect(html.match(/data-hunk-line=/g)).toHaveLength(7);
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

  it("is the card DraftCard shows for a GitHub review", () => {
    const html = renderToStaticMarkup(<DraftCard proposal={draft()} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} access={canPost} />);
    expect(html).toContain("data-github-review");
    expect(html).toContain("Loading the diff…");
    expect(html).toMatch(/<button[^>]*>Post review<\/button>/);
  });
});
