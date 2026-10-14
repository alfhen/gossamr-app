import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  commentOnTicket,
  editTicket,
  expandNeedsYou,
  homeComposer,
  homeConversationRegion,
  homeSettled,
  jiraWrites,
  mockRuns,
  needOfKind,
  needRow,
  needsPane,
  needsYouCount,
  needsYouRow,
  needsYouTray,
  openApp,
  openPipHome,
  paneSettled,
  pipHome,
  pipPane,
  seedWorkstreamEvent,
  startWorkstream,
  workstreamEvents,
  workstreamRow,
  workstreamWebText,
  expectToast,
} from "./support/app";

// What Pip does with a vague ticket after it speaks up: a free word check says so when the workstream opens (a notice, not a
// need), asking the reporter records that the workstream waits on them, the answers go to Jira as a comment, and Plan anyway
// hands the plan the questions it assumes answers to.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";
const GAPS = "it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it.";
const CLEAR = "The welcome flow should send three emails. Only the welcome flow is in scope; the winback flow is not. The CRM team is waiting on it. Done when all three send in the sandbox.";

const toast = (page: Page) => page.locator("[data-toast]");
const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");
const nextLine = (page: Page) => pipHome(page).locator("[data-next-step]");
const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** Moves run `id` on to done once Pip has answered, so each finish gets a wake turn of its own. */
async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** A managed workstream on the vague ticket, its investigation and the triage a rule started: not ready to plan. Left on Pip home. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

/** Ask the reporter on the readiness need, then post the comment: the workstream waits on the reporter. */
async function askAndPost(page: Page) {
  await needOfKind(page, "readiness").click();
  await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
  await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Post comment" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", VAGUE]]);
  // The finished investigation may still wait to be read, which is a need and ranks above the wait; the Next line says the wait.
  await expect(pipHome(page).locator("[data-next-step]")).toContainText("Waiting on the reporter since");
}

test.describe("G13: Pip speaks up when a workstream opens on a vague ticket", () => {
  test("a notice names what is missing the moment the workstream opens, is no need, and a ticket that says it all gets none", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    // Nobody typed anything: Pip's pane already says it.
    await expect(notice(pipPane(page))).toContainText(`${VAGUE} may be unclear: ${GAPS}`);
    await expect(notice(pipPane(page)).getByRole("button", { name: "Ask the reporter now" })).toBeVisible();
    await expect(notice(pipPane(page)).getByRole("button", { name: "Looks fine" })).toBeVisible();
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    await expect(notice(pipHome(page))).toContainText(`${VAGUE} may be unclear`);
    // It is a look, not a duty: no need, no count, nothing in Jira, and nothing blocked.
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsYouTray(page)).toContainText("Nothing needs you.");
    expect(await jiraWrites(page)).toEqual([]);

    // A ticket whose description says what done looks like, what is in scope and who is waiting is not remarked on.
    await editTicket(page, "CA-401", { description: CLEAR });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(notice(pipHome(page))).toHaveCount(0);
  });

  test("Pip's first turn names the same gaps, and a clear ticket gets no such line", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await paneSettled(page);
    await askPip(page, "where do we stand?");
    await paneSettled(page);
    await expect(pipPane(page)).toContainText(`${VAGUE} may be unclear: ${GAPS}`);
    await editTicket(page, "CA-402", { description: CLEAR });
    await startWorkstream(page, "CA-402");
    await paneSettled(page);
    await askPip(page, "where do we stand?");
    await paneSettled(page);
    await expect(pipPane(page)).not.toContainText("CA-402 may be unclear");
  });

  test("Looks fine dismisses it for the ticket, audited, and writes nothing", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await notice(pipPane(page)).getByRole("button", { name: "Looks fine" }).click();
    await expect(notice(pipPane(page))).toHaveCount(0);
    const line = (await actions(page, "clarity_dismissed"))[0];
    expect(line.actor).toBe("person");
    expect(await jiraWrites(page)).toEqual([]);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    await expect(notice(pipHome(page))).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });

  test("Ask the reporter now drafts the questions for approval, posts nothing until approved, and then the workstream waits on the reporter", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    await notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
    await expectToast(page, "Here is the comment to the reporter. Nothing is posted until you press Post comment.");
    await expect(notice(pipHome(page))).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft.locator('[data-created-by="gossamr"]')).toHaveText("Drafted by Gossamr");
    await expect(draft).toContainText("@Mette Lund");
    await expect(draft).toContainText(`Before ${VAGUE} can be planned`);
    for (const q of ["What is the goal?", "How will we know it is done (the acceptance criteria)?", "What is in scope, and what is out?", "Who asked for it, and who is waiting on it?"]) await expect(draft).toContainText(q);
    expect((await actions(page, "clarity_asked")).map((e) => e.actor)).toEqual(["person"]);
    // Not waiting yet: the comment has not been posted.
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).not.toContainText("Waiting on reporter");

    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", VAGUE]]);
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).toHaveText("Waiting on reporter");
    await expect(nextLine(page)).toHaveText("Next: Waiting on the reporter since just now; nothing starts on its own.");
    // It is not a need, and it is not counted.
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsYouTray(page)).toContainText("Nothing needs you.");
    await expect(notice(pipHome(page))).toHaveCount(0);
    // The note that nothing is posted yet is not true any more.
    await expect(toast(page).filter({ hasText: "Nothing is posted until you press Post comment" })).toHaveCount(0);
  });

  test("posting the comment takes the 'nothing is posted yet' note away, and the timeline's lines and counts follow", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    await notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
    const note = toast(page).filter({ hasText: "Nothing is posted until you press Post comment" });
    await expect(note).toHaveCount(1);
    const count = (scope: Locator, filter: string) => scope.locator(`[data-filter="${filter}"] [data-filter-count]`).first();
    const lines = (scope: Locator) => scope.locator("[data-timeline-line]");
    await expect(lines(pipHome(page)).filter({ hasText: "You posted the questions for the reporter" })).toHaveCount(0);
    await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await expect(note).toHaveCount(0);
    // The posting is in the timeline's lines at once, and the Drafts count counts it as a draft decided.
    await expect(lines(pipHome(page)).filter({ hasText: "You posted the questions for the reporter" })).toHaveCount(1);
    await expect(count(pipHome(page), "all")).toHaveText("3");
    await expect(count(pipHome(page), "drafts")).toHaveText("1");
    await expect(count(pipHome(page), "decisions")).toHaveText("2");
  });

  test("skipping the comment takes the note away too", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    await notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
    const note = toast(page).filter({ hasText: "Nothing is posted until you press Post comment" });
    await expect(note).toHaveCount(1);
    await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Skip" }).click();
    await expect(note).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("G14: waiting on the reporter", () => {
  test("starts when the questions are posted and shows in the row and the Next line; the triage's plan stays off while it lasts", async ({ page }) => {
    await unclear(page);
    await askAndPost(page);
    await expect(nextLine(page)).toContainText("Waiting on the reporter since just now; nothing starts on its own.");
    // Not a need: nothing in Needs you says it, and the readiness question is answered.
    await expect(needsYouTray(page)).not.toContainText("Waiting on the reporter");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect(await newest(page, "plan")).toBeNull();
  });

  test("a comment from the reporter ends the wait, the row and the Next line stop saying so, and the question comes back as 'the reporter replied, plan now?'", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await askAndPost(page);
    await expect(nextLine(page)).toContainText("Waiting on the reporter");
    // The person's own comment on the ticket answers nothing.
    await commentOnTicket(page, VAGUE, "Any news?", "me");
    // A finished investigation still waiting to be read is a need, which ranks above the wait: the Next line says the wait.
    await expect(nextLine(page)).toContainText("Waiting on the reporter since");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    // The reporter's reply is a Jira comment: no audit line, no hold.
    await commentOnTicket(page, VAGUE, "Done means all three emails send in the sandbox. The CRM team is waiting.");
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).not.toContainText("Waiting on reporter");
    await expect(nextLine(page)).not.toContainText("Waiting on the reporter");
    const need = needRow(page, "the reporter replied, plan now?");
    await expect(need).toContainText(`${VAGUE}: the reporter replied, plan now?`);
    await need.click();
    for (const name of ["Plan now", "Still unclear (ask again)"]) await expect(needsPane(page).getByRole("button", { name })).toBeVisible();
    await expect(needsPane(page).getByRole("button", { name: "I'll answer" })).toHaveCount(0);
    expect(await newest(page, "plan")).toBeNull();
    expect((await workstreamEvents(page)).filter((e) => e.action === "basis_drifted")).toEqual([]);
    await needsPane(page).getByRole("button", { name: "Plan now" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    await started(page, "plan");
  });

  test("a reporter who hasn't answered for days grows the cobweb: 'Reporter hasn't answered for N days', and it is never a need", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    // Asked and posted three days ago, as the audit would say it.
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "clarity_asked", at: ago(3.2), proposalId: "old-ask" });
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "draft_approved", at: ago(3.1), proposalId: "old-ask" });
    const row = workstreamRow(page, VAGUE);
    await expect(row.locator("[data-status]")).toHaveText("Waiting on reporter");
    await expect(row).toHaveAttribute("data-wither", "2");
    await expect(workstreamWebText(page, VAGUE)).toHaveText("Reporter hasn't answered for 3 days");
    await expect(row.locator("[data-status-detail]")).toHaveText("· asked 3 days ago");
    await expect(row).toHaveAttribute("title", /^Reporter hasn't answered for 3 days/);
    await expect(nextLine(page)).toContainText("Waiting on the reporter since 3 days ago; nothing starts on its own.");
    await expect(needsYouCount(page)).toHaveText("0");
  });

  test("the ticket changing while waiting brings the question back as 'changed: plan now?', and Plan now starts the plan with the questions it assumes answers to", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await askAndPost(page);

    await editTicket(page, VAGUE, { description: "Win back lapsed customers with three emails over two weeks." });
    // The existing drift holds the workstream; the wait is over.
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).not.toContainText("Waiting on reporter");
    // The hold says the ticket changed while the workstream waited on the reporter, and where Resume leads.
    const banner = pipHome(page).locator("[data-held-banner]");
    await expect(banner).toContainText(`Held: ${VAGUE}'s description changed while waiting on the reporter. Resume, then decide whether to plan now.`);
    await expect(banner).not.toContainText("changed in Jira");
    await banner.getByRole("button", { name: "Resume" }).click();
    const need = needRow(page, "changed: plan now?");
    await expect(need).toContainText(`${VAGUE} changed: plan now?`);
    await need.click();
    // The decision shows what the ticket says now, not only that it changed.
    const now = needsPane(page).locator("[data-ticket-now]");
    await expect(now).toContainText("The ticket now says");
    await expect(now).toContainText("Win back lapsed customers with three emails over two weeks.");
    for (const name of ["Plan now", "Still unclear (ask again)"]) await expect(needsPane(page).getByRole("button", { name })).toBeVisible();
    await expect(needsPane(page).getByRole("button", { name: "I'll answer" })).toHaveCount(0);
    await needsPane(page).getByRole("button", { name: "Plan now" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect((await actions(page, "readiness_overridden")).map((e) => e.actor)).toEqual(["person"]);
    const plan = await started(page, "plan");

    // G17: the plan was told the open questions it assumes answers to, and its description draft lists them.
    await finish(page, plan.id);
    await expect(needOfKind(page, "plan")).toBeVisible();
    await needOfKind(page, "plan").click();
    await expect(needsPane(page)).toContainText("Open questions the plan assumes answers to");
    await expect(needsPane(page)).toContainText("What does done look like for CA-408?");
    await expect(needsPane(page)).toContainText("Who asked for this, and who is waiting on it?");
  });

  test("Still unclear (ask again) drafts the comment again for approval and the wait begins with its post", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await askAndPost(page);
    await editTicket(page, VAGUE, { description: "Win back lapsed customers somehow." });
    await pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" }).click();
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Still unclear (ask again)" }).click();
    await expectToast(page, "Here is the comment to the reporter.");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect((await actions(page, "readiness_asked")).length).toBe(2);
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).not.toContainText("Waiting on reporter");
    await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(2);
    // A finished investigation still waiting to be read is a need, which ranks above the wait: the Next line says the wait.
    await expect(nextLine(page)).toContainText("Waiting on the reporter since");
  });

  test("choosing I'll answer or Plan anyway ends it, and so does the person resuming", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await askAndPost(page);
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(pipHome(page).locator("[data-held-banner]")).toContainText("Held by you");
    await pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" }).click();
    await expect(workstreamRow(page, VAGUE).locator("[data-status]")).not.toContainText("Waiting on reporter");
    await expect(nextLine(page)).not.toContainText("Waiting on the reporter");
    // The question is not back: the ticket did not change.
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
  });
});

test.describe("G14b: a drift with no wait keeps the usual banner", () => {
  test("the ticket changing while nobody waits on the reporter says what it always said", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await editTicket(page, VAGUE, { description: "Win back lapsed customers." });
    const banner = pipHome(page).locator("[data-held-banner]");
    await expect(banner).toContainText("changed in Jira");
    await expect(banner).not.toContainText("waiting on the reporter");
  });

  test("a long description is cut to its start, the rest a disclosure away", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await askAndPost(page);
    const long = `Win back lapsed customers with three emails over two weeks. ${"Each one names the customer's last order. ".repeat(12)}LAST SENTENCE.`;
    await editTicket(page, VAGUE, { description: long });
    await pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" }).click();
    await needRow(page, "changed: plan now?").click();
    const now = needsPane(page).locator("[data-ticket-now]");
    await expect(now).toContainText("Win back lapsed customers with three emails over two weeks.");
    await expect(now.locator("details")).not.toHaveAttribute("open", "");
    await expect(now.locator("p").nth(1)).not.toContainText("LAST SENTENCE.");
    await now.locator("summary").click();
    await expect(now.locator("details")).toContainText("LAST SENTENCE.");
  });
});

test.describe("G15: the person's answers go to Jira as a comment", () => {
  test("I'll answer, then Pip drafts 'Answers to the open questions' for approval, each answer under its question, never a rewrite, and proposes the plan only once it is posted", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(homeComposer(page)).toHaveValue(/My answers: $/);
    const prefill = await homeComposer(page).inputValue();
    await homeComposer(page).fill(`${prefill}Done means the winback mail goes to lapsed customers. We only touch the winback flow. The CRM team asked for it.`);
    await homeComposer(page).press("Enter");
    await homeSettled(page);

    await expandNeedsYou(page, VAGUE);
    const row = needRow(page, "Answers to the open questions");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await row.click();
    await expect(needsPane(page)).toContainText("Pip drafted a comment on CA-408 with your answers to the open questions; it is posted only when you approve it.");
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft).toContainText("Answers to the open questions");
    await expect(draft).toContainText("“What does done look like for CA-408? Which behaviour or number should change?”");
    // Three sentences for three questions: each answer sits under its question.
    await expect(draft).toContainText("“What does done look like for CA-408? Which behaviour or number should change?” Answer: Done means the winback mail goes to lapsed customers.");
    await expect(draft).toContainText("“What is in scope and what is out?” Answer: We only touch the winback flow.");
    await expect(draft).toContainText("“Who asked for this, and who is waiting on it?” Answer: The CRM team asked for it.");
    await expect(draft).not.toContainText("Answers:");
    // A comment, not a description rewrite; nothing is written before approval, and the plan waits for the post.
    await expect(needOfKind(page, "description")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    expect(await newest(page, "plan")).toBeNull();
    await expect(homeConversationRegion(page)).toContainText("nothing is posted until you approve it");
    await expect(homeConversationRegion(page)).toContainText("Once you post the answers, I'll draft the plan.");
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "Start Plan")).toHaveCount(0);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", VAGUE]]);
    // Pip's next turn proposes the plan, which does not start by itself.
    await askPip(page, "where do we stand?");
    await homeSettled(page);
    await expect(homeConversationRegion(page)).toContainText("Your answers are posted");
    expect(await newest(page, "plan")).toBeNull();
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "Start Plan")).toHaveCount(1);
  });

  test("the triage's own comment ('Triage could not size this') is retired, so it can't contradict the answers or be batched", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "R2 triage · comment")).toHaveCount(1);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    // Only the investigation's own comment is left in the group, so it has nothing to expand.
    await expect(needsYouTray(page)).not.toContainText("R2 triage · comment");
    await expect(needsYouRow(page, VAGUE).getByRole("button", { name: /^Approve \d+ safe drafts$/ })).toHaveCount(0);
    expect((await actions(page, "draft_superseded")).map((e) => e.actor)).toEqual(["person"]);
    // The answers come, and nothing left waits but them.
    await expect(homeComposer(page)).toHaveValue(/My answers: $/);
    await homeComposer(page).fill(`${await homeComposer(page).inputValue()}It is all about lapsed customers.`);
    await expect(homeComposer(page)).toHaveValue(/My answers: It is all about lapsed customers\.$/);
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "Answers to the open questions")).toHaveCount(1);
    await expect(needRow(page, "R2 triage · comment")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("it is never one of 'Approve N safe drafts': read and approved on its own", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(homeComposer(page)).toHaveValue(/My answers: $/);
    await homeComposer(page).fill(`${await homeComposer(page).inputValue()}It is all about lapsed customers.`);
    await expect(homeComposer(page)).toHaveValue(/My answers: It is all about lapsed customers\.$/);
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "Answers to the open questions")).toHaveCount(1);
    // Whatever the batch offers, the preview of what it would approve leaves the answers out.
    const batch = needsYouRow(page, VAGUE).getByRole("button", { name: /^Approve \d+ safe drafts$/ });
    if (await batch.count()) {
      await batch.click();
      await expect(needsPane(page)).toContainText("safe drafts");
      await expect(needsPane(page)).not.toContainText("Answers to the open questions");
    }
  });
});

test.describe("G16: asking the reporter retires the triage's own comment that repeats the questions", () => {
  test("only the questions draft waits, so 'Approve N safe drafts' can't post both", async ({ page }) => {
    await unclear(page);
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "R2 triage · comment")).toHaveCount(1);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "Questions for the reporter")).toHaveCount(1);
    await expect(needRow(page, "R2 triage · comment")).toHaveCount(0);
    await expect(needsYouRow(page, VAGUE).getByRole("button", { name: /^Approve \d+ safe drafts$/ })).toHaveCount(0);
    // The retired draft says what replaced it; nothing was posted.
    expect((await actions(page, "draft_superseded")).length).toBe(1);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("G16b: Plan anyway retires it too", () => {
  test("the triage's own comment doesn't wait beside a plan the person chose to start", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await expandNeedsYou(page, VAGUE);
    await expect(needRow(page, "R2 triage · comment")).toHaveCount(1);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Plan anyway" }).click();
    await started(page, "plan");
    // Nothing of the triage's note is left to approve; the group may be gone altogether.
    await expect(needsYouTray(page)).not.toContainText("R2 triage · comment");
    expect((await actions(page, "draft_superseded")).length).toBe(1);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("G17: Plan anyway hands the plan the open questions", () => {
  test("the plan's description draft lists them as the open questions the plan assumes answers to", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Plan anyway" }).click();
    const plan = await started(page, "plan");
    await finish(page, plan.id);
    await needOfKind(page, "plan").click();
    const pane = needsPane(page);
    await expect(pane).toContainText("Open questions the plan assumes answers to");
    for (const q of ["What does done look like for CA-408?", "What is in scope and what is out?", "Who asked for this, and who is waiting on it?"]) await expect(pane).toContainText(q);
    // The plan's summary says it rests on assumed answers, and each is stated with what the plan assumed.
    await expect(pane).toContainText("Assumes answers to 3 open questions from triage (listed at the end).");
    expect((await pane.innerText()).match(/Assumed:/g)).toHaveLength(3);
    expect(await jiraWrites(page)).toEqual([]);
  });
});
