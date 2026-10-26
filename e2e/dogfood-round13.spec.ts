import { expect, test } from "@playwright/test";
import { needsPane, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream } from "./support/app";

// Fixes from the thirteenth dogfood round: the "Done: … Now: …" line goes when Undo brings the skipped draft back (G11),
// the comment draft's edit field (G4), the toast's live region (G5), where the keyboard lands on a comment draft (G6)
// and the palette's focus (G8).

test.describe("a skipped comment draft (G11)", () => {
  test("Undo after Skip takes the Done line away", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(page.locator("[data-toast]").getByRole("button", { name: "Undo" })).toBeVisible();
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveCount(0);
  });
});

test.describe("a comment draft for a keyboard and a screen reader (G4, G5, G6)", () => {
  test("takes the keyboard on its card, names its edit field and keeps the toast's live region to its message", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    // In the decision that shows it, not on the Manage switch, which Space would flip.
    await expect(needsPane(page).locator(":focus")).toHaveCount(1);
    await expect(page.locator('[role="switch"]:focus')).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(draft.getByRole("combobox", { name: /Edit the comment on CA-408/ })).toBeVisible();
    await draft.getByRole("button", { name: "Skip" }).click();
    const live = page.locator("[data-toast-status]");
    await expect(live).toHaveAttribute("role", "status");
    const message = (await live.textContent()) ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(await page.locator('[role="status"]:has([data-toast-action])').count()).toBe(0);
    await expect(page.locator("[data-toast]").getByRole("button", { name: /^Undo[^:]*: / })).toBeVisible();
    expect(await page.locator("[data-toast] > span").first().textContent()).toBe(message);
  });
});

test.describe("the palette's focus (G8)", () => {
  test("stays in the search through a mouse pick of Start a workstream…, and What Jira saw from me opens on its heading", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("start");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("option", { name: /Start a workstream…/ }).click();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("What Jira saw");
    await dialog.getByRole("option", { name: /What Jira saw from me/ }).click();
    await expect(page.locator("[data-jira-sent]").getByRole("heading", { level: 1, name: "What Jira saw from me" })).toBeFocused();
  });
});
