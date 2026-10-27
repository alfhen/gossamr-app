import { expect, test, type Page } from "@playwright/test";
import { askPip, expandNeedsYou, homeSettled, jiraWrites, needRow, needsPane, needsYouCount, needsYouRow, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream, needsStack } from "./support/app";

// Backlog items of the seventeenth dogfood round: a draft that holds a secret saying so before Post (G22) and the skip Undo
// naming its draft (G27).

const toast = (page: Page) => page.locator("[data-toast]");

test.describe("a draft that holds a secret says so before Post (G22)", () => {
  test("the edited draft keeps the text as written and says the pause is coming", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter22secret`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(draft).toContainText("hunter22secret");
    await expect(draft.locator("[data-secret-note]")).toContainText("This holds something that looks like a secret. Gossamr will pause before posting it.");
    await draft.getByRole("button", { name: "Approve" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the skip Undo names the draft (G27)", () => {
  test("the Undo toast quotes the draft's first words, and a batch leaves the other groups their rows", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
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
