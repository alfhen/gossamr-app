import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream } from "./support/app";

// Backlog items of the fourteenth dogfood round: a posted secret masked on What Jira saw from me (G26) and the comment's
// edit box having room (G29).

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

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

test.describe("a posted secret on What Jira saw from me (G26)", () => {
  test("is masked, with the rest of the text kept and a note saying so", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter22secret`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await draft.locator("[data-post-pause]").getByRole("button", { name: "Post anyway" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    // The pause's line numbers are for the pause only: the posted text carries none.
    expect((await jiraWrites(page))[0].text).not.toMatch(/\(line \d+\)/);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const entry = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(entry).toBeVisible();
    await expect(entry.locator("[data-sent-masked]")).toContainText("looked like a password, key or token and is hidden here");
    await entry.getByRole("button", { name: /^Show the posted text/ }).click();
    const detail = entry.locator("[data-sent-detail]");
    await expect(detail).toContainText("Password: hu…");
    await expect(detail).not.toContainText("hunter22secret");
    await expect(detail).not.toContainText("(line ");
    await expect(entry).not.toContainText("hunter22secret");
    // The rest of the comment is still there.
    await expect(detail).toContainText("Checking in on this one.");
  });
});

test.describe("room to edit and to read the closed list (G29)", () => {
  test("the comment's edit box is about six lines tall at least", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const box = await needsPane(page).locator("textarea").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(150);
  });
});
