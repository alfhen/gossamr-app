import { expect, test } from "@playwright/test";
import { expandNeedsYou, needsPane, openAgents, openApp, openNeedRow, groupOpen, needsStack } from "./support/app";

// Fixes from the fifth dogfood round: Needs you on Pip home shows each need once.

test.describe("Needs you on Pip home (G5)", () => {
  test("opens No workstream's detail with every need listed once, the first one open, each with a chip that says what it means", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await groupOpen(page, "General").click();
    const items = needsStack(page).locator("[data-needs-pane]");
    await expect(items.nth(1)).toBeVisible();
    await expect(items.first()).toHaveAttribute("data-open", "true");
    await expect(needsPane(page)).toHaveCount(1);
    await expect(needsStack(page).locator("[data-needs-you-chip]").first()).toHaveAttribute("title", /^(Decide|Unblock|Approve): /);
  });
});

test.describe("the permission panel says what Deny does (G11)", () => {
  test("says it under the buttons; a read-only run's Deny needs no confirm", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
    const pane = needsPane(page);
    await expect(pane.locator("[data-permission-ask]")).toContainText("Claude is told you said no");
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(pane.getByRole("group", { name: "Deny this request" })).toHaveCount(0);
  });
});

