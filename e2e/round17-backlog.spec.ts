import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, expandNeedsYou, homeComposer, homeSettled, jiraWrites, mockRuns, needOfKind, needRow, needsPane, needsYouCount, needsYouRow, openAgents, openApp, paneSettled, pipPane, seedWorkstreamEvent, selectWorkstream, startWorkstream, openNeedOfKind, openNeedRow, needsStack } from "./support/app";

// Backlog items of the seventeenth dogfood round: the timeline telling Plan now from Plan anyway (G18), a draft that holds a secret saying so before Post (G22), the skip Undo naming its draft (G27), the Start-an-agent card's
// names (G28) and Looks fine saying what comes next (G29).

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";
const toast = (page: Page) => page.locator("[data-toast]");
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** Moves run `id` on to done once Pip has answered. */
async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** A managed workstream on the vague ticket, its investigation and the triage a rule started: not ready to plan. Left on Pip home. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
  await finish(page, (await newest(page, "triage"))!.id);
  await openAgents(page);
  await selectWorkstream(page, VAGUE);
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("Plan now has its own line (G18)", () => {
  test("a Plan now after asking the reporter is not worded as Plan anyway", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "readiness_asked", at: new Date(Date.now() - 3000).toISOString(), runId: "t1", proposalId: "d1" });
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "readiness_overridden", at: new Date(Date.now() - 2000).toISOString(), runId: "t1" });
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "readiness_overridden", at: new Date(Date.now() - 1000).toISOString(), runId: "t2" });
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline).toContainText(/chose to plan now, after asking the reporter about/);
    await expect(timeline).toContainText(/chose to plan anyway after .* found the ticket not ready/);
    await expect(timeline).not.toContainText(/chose to plan anyway after (?!.*t2).*t1/);
  });
});

test.describe("a draft that holds a secret says so before Post (G22)", () => {
  test("the answers draft keeps the text as written and says the pause is coming", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    const prefill = await homeComposer(page).inputValue();
    await homeComposer(page).fill(`${prefill}Done means the winback mail goes out. Password: hunter22secret. We only touch the winback flow. The CRM team asked for it.`);
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expandNeedsYou(page, VAGUE);
    await openNeedRow(page, "Answers to the open questions");
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft).toContainText("hunter22secret");
    await expect(draft.locator("[data-secret-note]")).toContainText("This holds something that looks like a secret. Gossamr will pause before posting it.");
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("Looks fine says what comes next (G29)", () => {
  test("a short toast says the agent step can be started from the conversation", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await expect(pipPane(page).locator("[data-clarity-notice]")).toBeVisible();
    await pipPane(page).locator("[data-clarity-notice]").getByRole("button", { name: "Looks fine" }).click();
    await expect(toast(page).filter({ hasText: "The agent step can be started from the conversation." })).toHaveCount(1);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the skip Undo names the draft (G27)", () => {
  test("the Undo toast quotes the draft's first words, and a batch leaves the other groups their rows", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "wsManage=1");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await askPip(page, "move it to QA");
    await homeSettled(page);
    const sample = Number(await needsYouCount(page).innerText()) - 3;
    await expandNeedsYou(page, "CA-401");
    const comment = needRow(page, /Draft comment/).first();
    await comment.click();
    await needsPane(page).getByRole("button", { name: "Skip" }).click();
    await expect(toast(page).filter({ hasText: /^Skipped the draft on CA-401: “.+”\./ })).toHaveCount(1);
    expect(sample).toBeGreaterThan(0);
    // The rest of the group still has its rows and the batch still offers what is left.
    await expect(needsYouRow(page, "CA-401")).toBeVisible();
    const batch = needsStack(page).getByRole("button", { name: /^Approve \d+ safe drafts?$/ });
    await batch.click();
    await needsPane(page).getByRole("button", { name: /^Yes, approve \d+/ }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBeGreaterThan(0);
    // Not reproduced: the group keeps the decision a batch never takes, and General keeps its own rows.
    await expect(needsStack(page)).toContainText("An agent wrote the plan for CA-401");
    await expect(needsYouCount(page)).toHaveText(String(sample));
    await expect(needsYouRow(page, "General")).toBeVisible();
  });
});
