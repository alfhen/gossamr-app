import { expect, test } from "@playwright/test";
import { openAgents, openApp } from "./support/app";

test("Settings states what Gossamr posts and what agents may do, and Work does not", async ({ page }) => {
  await openApp(page, "runs=empty");
  await openAgents(page);
  await expect(page.locator("body")).not.toContainText("until you approve it");
  await expect(page.locator("body")).not.toContainText("Claude Code settings");
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  const promises = page.locator("[data-promises] li");
  await expect(promises).toHaveText(["Gossamr posts nothing to Jira or GitHub until you approve it.", "Agents run with your own Claude Code settings, so they can push branches and use your own tools."]);
});
