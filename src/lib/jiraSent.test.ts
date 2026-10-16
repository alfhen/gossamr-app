import { describe, expect, it } from "vitest";
import type { Intent, Proposal, Run, WorkDoc, WorkstreamEvent, WorkstreamView } from "../types";
import { cutWords, editedWords, jiraSent, sentWhat } from "./jiraSent";

const ago = (hours: number) => new Date(Date.parse("2026-10-13T12:00:00Z") - hours * 3_600_000).toISOString();
const ref = (key: string) => ({ connectionId: "c", externalId: key, key });
const doc = (text: string): WorkDoc => ({ blocks: text.split("\n\n").map((t) => ({ type: "paragraph", content: [{ type: "text", text: t, marks: [] }] })) }) as WorkDoc;

const draft = (id: string, intent: Intent, over: Partial<Proposal> = {}): Proposal =>
  ({ id, createdAt: ago(30), updatedAt: ago(5), origin: { type: "chat", requestId: "r", workstream: "w1" }, createdBy: "pip", intent, label: null, basis: null, state: { type: "applied" }, revisions: [], created: [], error: null, run: null, ...over }) as Proposal;

const comment = (key: string, text: string): Intent => ({ type: "comment", item: ref(key), body: doc(text) });

const view = (id: string, key: string): WorkstreamView => ({ workstream: { id, itemKey: key, title: `${key} title`, closedAt: null }, labels: [["r3", "R3"]], runs: [] }) as unknown as WorkstreamView;

const approved = (proposalId: string, at: string, actor: WorkstreamEvent["actor"] = "person"): WorkstreamEvent => ({ workstreamId: "w1", seq: 1, at, actor, action: "draft_approved", runId: null, proposalId, digest: null, detail: null });

describe("What Jira saw from me", () => {
  it("lists what was posted, newest first: comments, moves, description edits and subtasks", () => {
    const proposals = [
      draft("c1", comment("CA-401", "Investigated: the cache key is wrong.\n\nFix is one line."), { updatedAt: ago(8) }),
      draft("t1", { type: "transition", item: ref("CA-401"), to: "31" }, { label: "In Review", updatedAt: ago(4) }),
      draft("r1", { type: "rewrite", item: ref("CA-402"), title: { from: "Old", to: "New" }, body: { from: doc("a"), to: doc("b"), fromText: "a", toText: "A better description.\n\nWith detail." }, flattened: [] }, { updatedAt: ago(2) }),
      draft("s1", { type: "subtasks", parent: ref("CA-403"), summaries: ["Write tests", "Update docs"] }, { updatedAt: ago(1) }),
    ];
    const out = jiraSent({ proposals, events: {}, workstreams: [view("w1", "CA-401")] });
    expect(out.map((e) => [e.id, e.kind, e.ticketKey])).toEqual([
      ["s1", "subtasks", "CA-403"],
      ["r1", "description", "CA-402"],
      ["t1", "transition", "CA-401"],
      ["c1", "comment", "CA-401"],
    ]);
    expect(out.map((e) => e.summary)).toEqual(["2 subtasks: Write tests; Update docs", "Description rewritten and title changed", "Moved to In Review", "Investigated: the cache key is wrong."]);
    expect(out[3].detail).toEqual(["Investigated: the cache key is wrong.", "", "Fix is one line."]);
    // The old text is shown beside the new: "a" (as drafted) is replaced by the new two paragraphs.
    expect(out[1].detail).toEqual(["Title: Old → New", "Description, as it read and as it now reads:", "− a", "+ A better description.", "+ ", "+ With detail."]);
  });

  it("shows what a description rewrite replaced, with unchanged lines folded", () => {
    const rewrite = (fromText: string, toText: string): Intent => ({ type: "rewrite", item: ref("CA-402"), title: null, body: { from: doc("a"), to: doc("b"), fromText, toText }, flattened: [] });
    const many = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
    const detail = sentWhat(rewrite(many, many.replace("seven", "7")), null)!.detail;
    expect(detail).toEqual(["Description, as it read and as it now reads:", "… 4 unchanged lines", "  five", "  six", "− seven", "+ 7"]);
  });

  it("calls an edit that only adds an addition, and one on an empty description a new description", () => {
    const rewrite = (fromText: string, toText: string, title: { from: string; to: string } | null = null): Intent => ({ type: "rewrite", item: ref("CA-402"), title, body: { from: doc("a"), to: doc("b"), fromText, toText }, flattened: [] });
    expect(sentWhat(rewrite("Line one", "Line one\nLine two"), null)).toMatchObject({ summary: "Added to the description", detail: ["Added to the description:", "  Line one", "+ Line two"] });
    expect(sentWhat(rewrite("Line one", "Line one\nLine two", { from: "A", to: "B" }), null)!.summary).toBe("Added to the description and title changed");
    // A plan's first added line is its heading: the preview says what the plan holds, without markdown (G9).
    expect(sentWhat(rewrite("Line one", "Line one\n\n## Gossamr Plan\n\n---\n- Fix the login redirect\n- Add a test"), null)!.second).toBe("Fix the login redirect");
    // Plus bullets and numbered steps are list markers too; a "+" or number that is part of the text stays.
    expect(sentWhat(rewrite("Line one", "Line one\n+ Fix the redirect"), null)!.second).toBe("Fix the redirect");
    expect(sentWhat(rewrite("Line one", "Line one\n1. Fix the redirect"), null)!.second).toBe("Fix the redirect");
    expect(sentWhat(rewrite("Line one", "Line one\n2) Add a test"), null)!.second).toBe("Add a test");
    expect(sentWhat(rewrite("Line one", "Line one\n+5 rows per page"), null)!.second).toBe("+5 rows per page");
    expect(sentWhat(rewrite("Line one", "Line one\n\n## Gossamr Plan"), null)!.second).toBe("Gossamr Plan");
    expect(sentWhat(rewrite("", "Fresh text"), null)).toMatchObject({ summary: "Description added", detail: ["The new description:", "+ Fresh text"] });
    expect(sentWhat(rewrite("Line one", "Line 1"), null)!.summary).toBe("Description rewritten");
  });

  it("gives a description row a type that says what its summary does, not 'Description edit' over 'Description added' (G29)", () => {
    const rewrite = (fromText: string, toText: string, title: { from: string; to: string } | null = null): Intent => ({ type: "rewrite", item: ref("CA-402"), title, body: fromText === toText ? null : { from: doc("a"), to: doc("b"), fromText, toText }, flattened: [] });
    expect(sentWhat(rewrite("", "Fresh text"), null)).toMatchObject({ label: "New description", summary: "Description added" });
    expect(sentWhat(rewrite("Line one", "Line one\nLine two"), null)).toMatchObject({ label: "Description addition", summary: "Added to the description" });
    expect(sentWhat(rewrite("Line one", "Line 1"), null)).toMatchObject({ label: "Description rewrite", summary: "Description rewritten" });
    expect(sentWhat(rewrite("x", "x", { from: "A", to: "B" }), null)).toMatchObject({ label: "Title change", summary: "Title changed to B" });
    const p = draft("r", rewrite("", "Fresh text"));
    expect(jiraSent({ proposals: [p], events: {}, workstreams: [] })[0]).toMatchObject({ kind: "description", label: "New description" });
  });

  it("says who made it once in the footer: Gossamr's own draft came from the person's request, not from Gossamr (G29)", () => {
    const asked = draft("d", comment("CA-401", "x"), { createdBy: "user", label: "Questions for the reporter", origin: { type: "chat", requestId: "clarity:w1", workstream: "w1" } });
    const [e] = jiraSent({ proposals: [asked], events: {}, workstreams: [view("w1", "CA-401")] });
    const footer = `${editedWords(e)} · from ${e.from}`;
    expect(footer).toBe("Gossamr drafted it; posted without changes · from your request");
    expect(footer.match(/Gossamr/g)).toHaveLength(1);
  });

  it("names the keys a subtasks draft created, one for each title", () => {
    const intent: Intent = { type: "subtasks", parent: ref("CA-403"), summaries: ["Write tests", "Update docs"] };
    expect(sentWhat(intent, null, [ref("CA-501"), ref("CA-502")])).toMatchObject({ summary: "2 subtasks: CA-501 Write tests; CA-502 Update docs", detail: ["• CA-501 Write tests", "• CA-502 Update docs"] });
    // Without keys (a draft from before they were kept) it lists the titles alone.
    expect(sentWhat(intent, null)!.detail).toEqual(["• Write tests", "• Update docs"]);
    const out = jiraSent({ proposals: [draft("s1", intent, { created: [ref("CA-501"), ref("CA-502")] })], events: {}, workstreams: [] });
    expect(out[0].detail).toEqual(["• CA-501 Write tests", "• CA-502 Update docs"]);
  });

  it("leaves out what Jira never saw: waiting, skipped, retired and approving-in-progress drafts, runs and GitHub reviews", () => {
    const states = (["pending", "applying", "skipped"] as const).map((s, i) => draft(`x${i}`, comment("CA-401", "hello"), { state: { type: s } as Proposal["state"] }));
    const retired = draft("x3", comment("CA-401", "hello"), { state: { type: "retired", reason: "Replaced" } });
    const run = draft("x4", { type: "startRun", connectionId: "c", item: null, spec: {} } as unknown as Intent);
    const review = draft("x5", { type: "githubReview", connectionId: "g", item: null, runId: "r", repo: "a/b", number: 1, commitSha: "abc", summary: "S", comments: [] });
    const follow = draft("x6", { type: "followUp", connectionId: "c", runId: "r", item: null, message: "m", reason: "r" });
    expect(jiraSent({ proposals: [...states, retired, run, review, follow], events: {}, workstreams: [] })).toEqual([]);
  });

  it("takes when it was approved, and which workstream, from the audit's draft_approved line when it has one", () => {
    const p = draft("c1", comment("CA-401", "hello"), { origin: { type: "board" }, updatedAt: ago(1) });
    const out = jiraSent({ proposals: [p], events: { w1: [approved("c1", ago(20))] }, workstreams: [view("w1", "CA-401")] });
    expect(out[0]).toMatchObject({ at: ago(20), workstreamId: "w1", workstream: "CA-401" });
    // Only the person's line is an approval; without one the draft says when it last changed.
    const other = jiraSent({ proposals: [p], events: { w1: [approved("c1", ago(20), "pip")] }, workstreams: [] });
    expect(other[0]).toMatchObject({ at: ago(1), workstreamId: null, workstream: null });
  });

  it("names a run outside the workstream's labels as the app does, never by its hex id", () => {
    const from = (runId: string, shortId: string | null, runs: Parameters<typeof jiraSent>[0]["runs"]) =>
      jiraSent({ proposals: [draft("g", comment("CA-401", "x"), { origin: { type: "run", runId, shortId, workstream: null }, createdBy: "agent" })], events: {}, workstreams: [view("w1", "CA-401")], runs })[0].from;
    const plan = { id: "r9", item: ref("CA-401"), spec: { kind: "plan" } } as unknown as Run;
    expect(from("r9", "1000addd", [plan])).toBe("the CA-401 plan");
    // Not known here: the draft's own ticket names it.
    expect(from("r8", "1000addd", [plan])).toBe("the CA-401 run");
    expect(from("r8", "1000addd", undefined)).not.toContain("1000addd");
  });

  it("says where the draft came from and who made it", () => {
    const pip = draft("a", comment("CA-401", "x"));
    const run = draft("b", comment("CA-401", "x"), { origin: { type: "run", runId: "r3", shortId: null, workstream: "w1" }, createdBy: "agent" });
    const board = draft("c", comment("CA-401", "x"), { origin: { type: "board" }, createdBy: "user" });
    const asked = draft("d", comment("CA-401", "x"), { createdBy: "user", label: "Questions for the reporter" });
    const nudge = draft("e", comment("CA-401", "x"), { createdBy: "user", label: "Nudge for the reporter" });
    const out = Object.fromEntries(jiraSent({ proposals: [pip, run, board, asked, nudge], events: {}, workstreams: [view("w1", "CA-401")] }).map((e) => [e.id, [e.madeBy, e.from]]));
    expect(out).toEqual({ a: ["Pip", "Pip, on CA-401"], b: ["An agent run", "run R3"], c: ["You", "the board"], d: ["Gossamr", "your request"], e: ["Gossamr", "your request"] });
    // Pip's chat draft with no ticket to name stays "Pip's conversation".
    const bare = draft("f", { type: "create", container: { connectionId: "c", externalId: "P", key: "P" }, fields: { title: "T", body: { blocks: [] } } } as unknown as Intent);
    expect(jiraSent({ proposals: [bare], events: {}, workstreams: [] })[0].from).toBe("Pip's conversation");
    const labels = Object.fromEntries(jiraSent({ proposals: [pip, asked, nudge], events: {}, workstreams: [view("w1", "CA-401")] }).map((e) => [e.id, [e.kind, e.label]]));
    expect(labels).toEqual({ a: ["comment", undefined], d: ["comment", "Questions to the reporter"], e: ["comment", "Nudge to the reporter"] });
  });

  it("says whether the person edited the draft before approving it", () => {
    const edited = draft("a", comment("CA-401", "x"), { revisions: [{ at: ago(6), note: "Revised by Pip", intent: comment("CA-401", "y") }, { at: ago(5), note: "Edited", intent: comment("CA-401", "z") }] });
    const pipOnly = draft("b", comment("CA-401", "x"), { revisions: [{ at: ago(6), note: "Revised by Pip", intent: comment("CA-401", "y") }] });
    const out = jiraSent({ proposals: [edited, pipOnly], events: {}, workstreams: [] });
    expect(Object.fromEntries(out.map((e) => [e.id, e.edited]))).toEqual({ a: true, b: false });
    expect(editedWords({ madeBy: "Pip", edited: true })).toBe("Pip drafted it; you edited it before approving");
    expect(editedWords({ madeBy: "Pip", edited: false })).toBe("Pip drafted it; posted without changes");
    expect(editedWords({ madeBy: "You", edited: false })).toBe("You wrote it");
    expect(editedWords({ madeBy: "You", edited: true })).toBe("You wrote it and edited it before approving");
  });

  it("cuts a long line at a word, not in the middle of one (G32)", () => {
    const words = "Before work starts a few things need clearing up so that the plan matches what the reporter actually has in mind for the export";
    const what = sentWhat(comment("CA-401", words), null)!;
    expect(what.summary).toBe("Before work starts a few things need clearing up so that the plan matches what the reporter actually has in mind for…");
    expect(what.summary.length).toBeLessThanOrEqual(120);
    // A word that ends right at the cut is kept whole; a run with no spaces is still cut at the limit.
    expect(cutWords("x".repeat(119) + " tail")).toBe(`${"x".repeat(119)}…`);
    expect(cutWords("y".repeat(300))).toBe(`${"y".repeat(119)}…`);
    expect(cutWords("short")).toBe("short");
  });

  it("keeps a long comment short on its line and whole behind the disclosure", () => {
    const long = "A".repeat(300);
    const what = sentWhat(comment("CA-401", long), null)!;
    expect(what.summary.length).toBeLessThanOrEqual(120);
    expect(what.summary.endsWith("…")).toBe(true);
    expect(what.detail).toEqual([long]);
  });

  it("covers the other writes: a new ticket, a change and a link, and no ticket key for a created one without a target", () => {
    const create = draft("n", { type: "create", container: { connectionId: "c", externalId: "p", key: "CA" } as never, fields: { title: "Fix it", body: doc("Details"), kind: "task", assignee: null, parent: null, priority: null, labels: [] }, link: null }, { created: [ref("CA-500")] });
    const link = draft("l", { type: "link", from: ref("CA-1"), to: ref("CA-2"), kind: "blocks" });
    const update = draft("u", { type: "update", item: ref("CA-3"), patch: { assignee: null, parent: null, priority: "high" } });
    const out = Object.fromEntries(jiraSent({ proposals: [create, link, update], events: {}, workstreams: [] }).map((e) => [e.id, [e.kind, e.summary, e.ticketKey]]));
    expect(out).toEqual({ n: ["ticket", "Created “Fix it”", "CA-500"], l: ["link", "Linked CA-1 blocks CA-2", "CA-1"], u: ["change", "Changed the priority to high", "CA-3"] });
  });
});

describe("the second line of a row (G25)", () => {
  const rewrite = (from: string, to: string): Intent => ({ type: "rewrite", item: ref("CA-402"), title: null, body: { from: doc(from), to: doc(to), fromText: from, toText: to }, flattened: [] }) as Intent;

  it("is the line after the opener for a comment, so two openers that read alike still differ", () => {
    expect(sentWhat(comment("CA-401", "Investigated the cache.\n\nThe key is built before the locale is known."), null)).toMatchObject({ summary: "Investigated the cache.", second: "The key is built before the locale is known." });
    // More lines than the two shown are counted, so a numbered reply doesn't read as one item.
    expect(sentWhat(comment("CA-401", "Before work starts:\n\n1. Goal?\n2. Scope?\n3. Owner?"), null)).toMatchObject({ summary: "Before work starts:", second: "1. Goal? (+2 more)" });
    // A greeting is skipped by the opener, so the second line is the one after it.
    expect(sentWhat(comment("CA-401", "Hi Mette,\n\nBefore work starts, a few things need clearing up:\n\n- What is the goal?"), null)).toMatchObject({ summary: "Before work starts, a few things need clearing up:", second: "- What is the goal?" });
  });

  it("counts the items still to come when a list is shown, not the lines: a closing line or a wrapped one is no item (G29)", () => {
    const text = "Before work starts, three things:\n\n1. Goal?\n2. Scope?\n3. Owner?\n\nThanks!";
    expect(sentWhat(comment("CA-401", text), null)).toMatchObject({ second: "1. Goal? (+2 more)" });
    expect(sentWhat(comment("CA-401", "Opener:\n\n- First?\nwrapped on from the first\n- Second?\n\nThanks, Pip"), null)).toMatchObject({ second: "- First? (+1 more)" });
    // Lines that are not a list are still counted as lines.
    expect(sentWhat(comment("CA-401", "Opener.\n\nOne.\n\nTwo.\n\nThree."), null)).toMatchObject({ second: "One. (+2 more)" });
    expect(sentWhat(comment("CA-401", "Opener:\n\n1. Only?\n\nThanks!"), null)!.second).toBe("1. Only?");
  });

  it("is left out of a one-line comment, and cut short like the summary", () => {
    expect(sentWhat(comment("CA-401", "Done."), null)!.second).toBeUndefined();
    const long = sentWhat(comment("CA-401", `Opener.\n\n${"B".repeat(300)}`), null)!;
    expect(long.second!.length).toBeLessThanOrEqual(120);
    expect(long.second!.endsWith("…")).toBe(true);
  });

  it("is the first line a description edit added, so 'Description added' says what was added", () => {
    expect(sentWhat(rewrite("", "Fresh text.\n\nMore."), null)).toMatchObject({ summary: "Description added", second: "Fresh text." });
    expect(sentWhat(rewrite("Line one", "Line one\nLine two"), null)).toMatchObject({ summary: "Added to the description", second: "Line two" });
    expect(sentWhat(rewrite("Line one", "Line 1"), null)).toMatchObject({ summary: "Description rewritten", second: "Line 1" });
  });

  it("is left out of a move, a link and a title-only change", () => {
    expect(sentWhat({ type: "transition", item: ref("CA-401"), to: "31" }, "Done")!.second).toBeUndefined();
    expect(sentWhat({ type: "rewrite", item: ref("CA-402"), title: { from: "Old", to: "New" }, body: null, flattened: [] } as Intent, null)!.second).toBeUndefined();
  });
});

describe("what the row shows of a comment to the reporter", () => {
  const asked = (id: string, text: string) => draft(id, comment("CA-401", text), { createdBy: "user", label: "Questions for the reporter", updatedAt: ago(Number(id.slice(1))) });
  const first = "Hi Mette,\n\nA few things about CA-401 need clearing up:\n\n- What is the goal?";
  const again = "Hi Mette,\n\nThanks for your answer above. A few things about CA-401 are still open:\n\n- What is in scope?";

  it("skips the greeting line in the short preview and keeps it in the whole", () => {
    const [e] = jiraSent({ proposals: [asked("a1", first)], events: {}, workstreams: [] });
    expect(e.summary).toBe("A few things about CA-401 need clearing up:");
    expect(e.detail[0]).toBe("Hi Mette,");
    expect(sentWhat(comment("CA-401", "Hi,"), null)!.summary).toBe("Hi,");
    expect(sentWhat(comment("CA-401", "Hello there, I moved this."), null)!.summary).toBe("Hello there, I moved this.");
  });

  it("calls a second ask after a reply a follow-up, not the same row twice", () => {
    const out = jiraSent({ proposals: [asked("a8", first), asked("a2", again)], events: {}, workstreams: [] });
    expect(out.map((e) => e.label)).toEqual(["Follow-up questions to the reporter", "Questions to the reporter"]);
  });

  it("masks a posted secret everywhere it is shown and says so, keeping the rest of the text", () => {
    const out = jiraSent({ proposals: [draft("k1", comment("CA-401", "Here is the login.\n\npassword: hunter22secret\n\nThanks")), draft("k2", comment("CA-401", "Plain text"))], events: {}, workstreams: [] });
    const [a, b] = out.sort((x, y) => x.id.localeCompare(y.id));
    expect(a.masked).toBe(true);
    expect(a.detail).toEqual(["Here is the login.", "", "password: hu…", "", "Thanks"]);
    expect(a.second).toBe("password: hu… (+1 more)");
    expect(JSON.stringify(a)).not.toContain("hunter22secret");
    expect(b.masked).toBe(false);
  });
});
