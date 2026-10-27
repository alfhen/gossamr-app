import { expect, test } from "@playwright/test";
import { askPip, pauseAtCeiling, homeSettled, needsPane, openAgents, openApp, selectWorkstream, startWorkstream, openNeedRow, needsStack } from "./support/app";

// Fixes from the eighth dogfood round: what the Decide pane's line says was posted.

test.describe("the Decide pane's Done line (G5)", () => {
  test("says a posted comment was posted to Jira, and names the next need's ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await openNeedRow(page, /Pip drafted a comment/);
    await pauseAtCeiling(page, "CA-401");
    await expect(needsStack(page)).toContainText("Paused: Pip was woken too often today");
    await needsPane(page).getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Paused: Pip was woken too often today$/);
  });
});
