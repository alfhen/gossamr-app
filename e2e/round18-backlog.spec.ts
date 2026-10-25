import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, editTicket, jiraWrites, mockRuns, needsPane, openAgents, openApp, peekSheet, peekTicket, pipConversation, pipPane, selectWorkstream, startWorkstream, stepChip, needRow } from "./support/app";

// Backlog items of the eighteenth dogfood round: Draft the Build after an approved plan in Advise (G14), the plan reading Approved once its
// draft is posted (G17), an edited draft reopening as a preview with Edit (G26), and the smaller polish (G27).

const MANAGED = "runs=empty&prSurface=manual&wsManage=1";
const FIRST_RUN = { cookies: [], origins: [] };
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
const nextLine = (page: Page) => pipPane(page).locator("[data-next-step]");
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Pip has finished its turn. A turn can take a while on a busy runner, so this waits longer than the default. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
}

/** Asks Pip for an investigation of CA-401 and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await settled(page);
  await runCards(page, "CA-401").last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

test.describe("Draft the Build after an approved plan in Advise (G14, G17)", () => {
  test("the Next line offers it, it drafts a Build for review and starts nothing, and the plan reads Approved", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await startInvestigation(page);
    await finish(page, (await newest(page, "investigate"))!.id);
    await finish(page, (await started(page, "triage")).id);
    await finish(page, (await started(page, "plan")).id);
    // Advise before the plan is approved, so approving it starts nothing by itself.
    const manage = pipPane(page).getByRole("switch", { name: "Manage this workstream" });
    await manage.click();
    await expect(manage).toHaveAttribute("aria-checked", "false");
    await expect(nextLine(page).locator("[data-next-draft]")).toHaveCount(0);

    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
    const plan = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
    await plan.getByRole("button", { name: "Update description" }).click();
    await expect(plan).toHaveCount(0);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

    // Other drafts still wait, so the line says so; the Build is still one press away beside it.
    const draft = nextLine(page).getByRole("button", { name: "Draft the Build" });
    await expect(draft).toBeVisible();
    await draft.click();
    // The same request as typing "Build this": Pip drafts a Build to review, and says it has not started.
    await settled(page);
    await expect(pipPane(page)).toContainText("Build this");
    await expect(pipPane(page)).toContainText("It has not started.");
    const card = runCards(page, "CA-401").last();
    await expect(card.getByRole("button", { name: "Review and start →" })).toBeVisible();
    expect(await newest(page, "build")).toBeNull();
    expect(await jiraWrites(page)).toHaveLength(1);

    // The plan's step no longer reads Ready to review: its draft was posted.
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Approved");
  });
});

test.describe("an edited draft reopens as a preview (G26)", () => {
  test("the kept text shows read-only with an Edit button, Edit opens the field with it, and Post posts it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: "Fix it." });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Kept after the card left.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    await needsPane(page).getByRole("button", { name: "Hide" }).click();
    await expect(draft).toHaveCount(0);
    await needRow(page, /drafted a comment to the reporter of CA-408/).click();
    await expect(draft).toContainText("Kept after the card left.");
    await expect(needsPane(page).locator("textarea")).toHaveCount(0);
    await expect(draft.getByRole("button", { name: "Done editing" })).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(needsPane(page).locator("textarea").first()).toHaveValue("Kept after the card left.");
    await expect(needsPane(page).locator("textarea").first()).toBeFocused();
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(draft.getByRole("button", { name: "Edit" })).toBeFocused();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.text)).toEqual([expect.stringContaining("Kept after the card left.")]);
  });
});

test.describe("the glossary and the picker (G27)", () => {
  test.use({ storageState: FIRST_RUN });

  test("the left rail is a named region", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("complementary", { name: "Workspace sidebar" })).toBeVisible();
  });
});
