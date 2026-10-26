import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, openAgents, openApp, pipCommentDraft, pipPane, selectWorkstream, startWorkstream } from "./support/app";

// Fixes from round 9's backlog: the keyboard odds and ends (G21) and the pause quoting what tripped it (G23).

const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** A comment on `key` drafted by Pip and left waiting in the decision pane. */
async function draftOn(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
  await openAgents(page);
  await selectWorkstream(page, key);
  return pipCommentDraft(page, key);
}

test.describe("the keyboard odds and ends (G21)", () => {
  test("Esc on the Close confirm keeps the keyboard on Close… with a toast up", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(toast(page)).toContainText("Paused CA-401.");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
  });
});

test.describe("the pause names what tripped it (G23)", () => {
  test("a broad mention as written, a secret masked to its first two characters", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    const pause = draft.locator("[data-post-pause]");
    const base = await needsPane(page).locator("textarea").count();
    expect(base).toBe(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    const original = await text.inputValue();
    await text.fill(`${original}\n\ncc @Everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("Your edit mentions everyone");
    await expect(pause).toContainText("at “@Everyone”");
    await expect(pause).not.toContainText("hunter2");
    // Another edit takes the pause back; with only the password it quotes that, masked.
    await draft.getByRole("button", { name: "Keep editing" }).click();
    await text.fill(`${original}\n\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("looks like a password, key or token at “hu…”");
    await expect(pause).not.toContainText("hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});
