import { expect, test } from "@playwright/test";
import { expandNeedsYou, mockAttached, needsPane, openAgents, openApp, openNeedRow, groupOpen, needsStack } from "./support/app";

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

test.describe("the permission panel", () => {
  test("shows the command and one way to answer it: Open in Terminal, said in one sentence", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
    const pane = needsPane(page);
    const ask = pane.locator("[data-permission-ask]");
    await expect(ask).toContainText("git push origin HEAD");
    await expect(ask).toContainText("you answer it in Terminal");
    await expect(ask.getByRole("button")).toHaveText(["Copy", "Open in Terminal"]);
    await expect(pane.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await ask.getByRole("button", { name: "Open in Terminal" }).click();
    await expect.poll(async () => (await mockAttached(page)).length).toBe(1);
  });
});

