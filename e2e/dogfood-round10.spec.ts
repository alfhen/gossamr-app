import { expect, test, type Locator, type Page } from "@playwright/test";
import { agentsHome, askPip, expandAllNeeds, expandNeedsYou, homeSettled, jiraWrites, needsPane, needsYouCount, openAgents, openApp, selectWorkstream, startWorkstream, openNeedRow, needsStack } from "./support/app";

// Fixes from the tenth dogfood round: the long description draft in the Decision pane keeping its actions in view (G10), the
// posting pause saying what tripped it, one sentence for each risk (G4), and a batch that does not post one comment twice (G2).

const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** Where a box is on the page. */
const box = async (locator: Locator) => (await locator.boundingBox())!;

test.describe("a long description draft in the Decision pane (G10)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("scrolls its diff in a box of its own, so Edit, Skip and Update description are in view on open", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=kinds");
    await openAgents(page);
    await expandAllNeeds(page);
    await openNeedRow(page, /Approve the plan/);
    const pane = needsPane(page);
    const draft = pane.getByRole("article", { name: /Update the description of CA-401/ });
    await expect(draft).toBeVisible();
    // Make the diff long: the pane's cap is what keeps the bar near it, so the draft is edited to be much longer than the cap.
    await draft.getByRole("button", { name: "Edit" }).click();
    const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long description.`).join("\n");
    await body.fill(`${await body.inputValue()}\n\n${lines}`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    const diff = draft.locator('[data-diff="description"]');
    expect(await diff.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(draft.locator("[data-diff-more]")).toContainText("Scroll for the whole diff");
    // The action bar is still in the flow, not sticky over the text, and sits right under the capped diff.
    const bar = draft.locator("[data-draft-actions]");
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    const paneBox = await box(pane);
    const update = await box(draft.getByRole("button", { name: "Update description" }));
    expect(update.y).toBeGreaterThanOrEqual(paneBox.y);
    expect(update.y + update.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
    expect(update.y + update.height).toBeLessThanOrEqual(900);
    // Scrolling the diff to its end takes the hint away.
    await diff.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(draft.locator("[data-diff-more]")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the pause before posting edited words (G4)", () => {
  test("says each risk in a sentence of its own, quotes both, and asks no question", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\ncc @everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause).toContainText("Your edit mentions everyone at “@everyone” (line 12). It also looks like a password, key or token at “hu…” (line 13). Everyone on the ticket would see it once it is posted.");
    await expect(pause).not.toContainText("Post anyway, or keep editing?");
    await expect(pause).not.toContainText("hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("Approve N safe drafts with two identical comments (G2)", () => {
  test("covers a comment and its copy once, says which it left out, and posts nothing until the confirm", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty&prSurface=manual&pipPace=1");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // Pip words a check-in three ways, so the fourth asked for says what the first did.
    for (let i = 0; i < 4; i++) {
      await askPip(page, "Draft a comment");
      await homeSettled(page);
    }
    await expect(needsYouCount(page)).toHaveText("4");
    await expandNeedsYou(page, "CA-401");
    const ws = needsStack(page);
    await expect(ws.getByRole("button", { name: "Approve 4 safe drafts" })).toHaveCount(0);
    await ws.getByRole("button", { name: "Approve 3 safe drafts" }).click();
    const pane = needsPane(page);
    await expect(pane.locator("[data-needs-you-batch-preview] li")).toHaveCount(3);
    await expect(pane.locator("[data-batch-left-out]")).toContainText("Same text as the comment above, left out");
    expect(await jiraWrites(page)).toEqual([]);
    await pane.getByRole("button", { name: "Yes, approve 3" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment", "comment"]);
    // The copy is still there, to be decided on its own.
    await expect(needsYouCount(page)).toHaveText("1");
  });
});

test.describe("Esc on the posting pause (G1)", () => {
  test("is Keep editing: the pause goes, the edited text stays and the field has the keyboard", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\ncc @everyone`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    await draft.locator("[data-post-pause-keep]").focus();
    await page.keyboard.press("Escape");
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await expect(text).toBeFocused();
    await expect(text).toHaveValue(/cc @everyone/);
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("is Keep editing from Post anyway too, with the edited text kept and editing open", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\ncc @everyone`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    const anyway = draft.getByRole("button", { name: "Post anyway" });
    await anyway.focus();
    await page.keyboard.press("Escape");
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await expect(text).toBeFocused();
    await expect(text).toHaveValue(/cc @everyone/);
    expect(await jiraWrites(page)).toEqual([]);
  });
});
