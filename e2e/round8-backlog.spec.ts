import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, needsYouCount, openAgents, openApp, pipCommentDraft, pipPane, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// Fixes from round 8's backlog: the workstream step says why a key has nothing to start, a pause before posting edited text that
// reaches everyone or looks like a secret, and Close beside Hold.

const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("the pause before posting edited text (G19)", () => {
  /** A comment on `key` drafted by Pip and left waiting in the decision pane. */
  async function draftOn(page: Page, key: string) {
    await allProjects(page);
    await startWorkstream(page, key);
    await openAgents(page);
    await selectWorkstream(page, key);
    return pipCommentDraft(page, key);
  }
  const addLine = async (page: Page, draft: ReturnType<Page["locator"]>, line: string) => {
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\n${line}`);
    await draft.getByRole("button", { name: "Done editing" }).click();
  };

  test("an edit that mentions everyone or holds a password waits for a second press, and is never blocked", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await addLine(page, draft, "cc @everyone\nPassword: hunter2");
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause).toContainText("Your edit mentions everyone");
    await expect(pause).toContainText("looks like a password, key or token");
    expect(await jiraWrites(page)).toEqual([]);
    // The person can pass it.
    await draft.getByRole("button", { name: "Post anyway" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
  });

  test("an edit that only mentions a person posts at once, and editing again takes the pause back", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await addLine(page, draft, "cc @everyone");
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    await draft.getByRole("button", { name: "Keep editing" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill((await text.inputValue()).replace("cc @everyone", "cc @Mette Lund"));
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
  });
});

test.describe("Close beside Pause (G21)", () => {
  test("an idle workstream's controls show Close, which asks before closing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask).toContainText("its agents and drafts are kept");
    // Keep takes it back; Close goes through.
    await ask.getByRole("button", { name: "Keep" }).click();
    await expect(ask).toHaveCount(0);
    // The keyboard goes back to Close, so Esc does as well.
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });
});
