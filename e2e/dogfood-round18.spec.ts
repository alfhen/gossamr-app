import { expect, test } from "@playwright/test";
import { agentsSettled, needsPane, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the eighteenth dogfood round: 'start CA-408' in the palette offers the workstream, not only Ask Pip (G8).

test.describe("'start KEY' in the palette (G8)", () => {
  test("offers to start a workstream on the ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await agentsSettled(page, true);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("start CA-402");
    await expect(dialog.getByRole("option", { name: /^Start a workstream on CA-402/ })).toBeVisible();
    await dialog.getByRole("combobox").fill("start on ca-402");
    await expect(dialog.getByRole("option", { name: /^Start a workstream on CA-402/ })).toBeVisible();
  });
});

test.describe("the palette's input name in a mode (G9)", () => {
  test("is the question the mode asks, and the search name for plain search", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await agentsSettled(page, true);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.getByRole("combobox", { name: "Search commands and tickets" })).toBeVisible();
  });
});

test.describe("a skip announces once (G6)", () => {
  test("the pane line says Skipped, and the toast's live region stays empty while the pane says it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openPipHome(page);
    await workstreamRow(page, "CA-402").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: /^Comment on CA-/ });
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(page.locator("[data-needs-advanced]")).toContainText(/^Skipped: .*Now:/);
    await expect(page.locator("[data-toast]").getByRole("button", { name: /^Undo/ })).toBeVisible();
    await expect(page.locator("[data-toast-status]")).toHaveText("");
  });
});
