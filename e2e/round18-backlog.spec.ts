import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, jiraWrites, mockRuns, needsPane, openAgents, openApp, peekSheet, peekTicket, pipCommentDraft, pipConversation, pipPane, selectWorkstream, startWorkstream, stepChip, needRow } from "./support/app";

// Backlog items of the eighteenth dogfood round: the plan reading Approved once its
// draft is posted (G17), an edited draft reopening as a preview with Edit (G26), and the rail being a named region (G27).

const SAMPLE = "runs=empty&prSurface=manual";
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.step === kind) ?? null;

/** Pip has finished its turn. A turn can take a while on a busy runner, so this waits longer than the default. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
}

/** Asks Pip for `what` on CA-401 which starts it. */
async function startStep(page: Page, what: string) {
  await askPip(page, what);
  await settled(page);
}

async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

test.describe("The plan reads Approved once its draft is posted (G17)", () => {
  test("the plan's step reads Ready to review until its description draft is posted, and Approved after", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, SAMPLE);
    await startWorkstream(page, "CA-401");
    for (const [what, kind] of [["investigate this", "investigate"], ["triage this", "triage"], ["plan this", "plan"]] as const) {
      await startStep(page, what);
      await finish(page, (await newest(page, kind))!.id);
    }
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Ready to review");

    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
    const plan = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
    await plan.getByRole("button", { name: "Update description" }).click();
    await expect(plan).toHaveCount(0);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
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
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Kept after the card left.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    await needsPane(page).getByRole("button", { name: "Hide" }).click();
    await expect(draft).toHaveCount(0);
    await needRow(page, /Draft comment/).click();
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

test.describe("the rail (G27)", () => {
  test("the left rail is a named region", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("complementary", { name: "Workspace sidebar" })).toBeVisible();
  });
});
