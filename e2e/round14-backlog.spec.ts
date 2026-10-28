import { expect, test, type Page } from "@playwright/test";
import { needsPane, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream } from "./support/app";

// The comment edit box has room (G29).

/** A comment on CA-408 drafted by Pip: a workstream on it, Pip asked for a comment, its card in the decision pane. */
async function commentDraft(page: Page) {
  await openApp(page, "runs=empty");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openAgents(page);
  await selectWorkstream(page, "CA-408");
  const draft = await pipCommentDraft(page, "CA-408");
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("room to edit and to read the closed list (G29)", () => {
  test("the comment's edit box is about six lines tall at least", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const box = await needsPane(page).locator("textarea").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(150);
  });
});
