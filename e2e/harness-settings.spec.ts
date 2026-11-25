import { expect, test, type Page } from "@playwright/test";
import { openAgents, openApp } from "./support/app";

async function openSettings(page: Page, query: string) {
  await openApp(page, query);
  await openAgents(page);
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  const section = page.locator("[data-harness]");
  await section.scrollIntoViewIfNeeded();
  return section;
}

test.describe("The harness in Settings", () => {
  test("says it runs and its build, and stops only once you confirm", async ({ page }) => {
    const harness = await openSettings(page, "runs=empty");
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
    await expect(harness).toContainText("build 2f6c1a9e04b7");
    await harness.getByRole("button", { name: "Stop all agents and the harness" }).click();
    await expect(harness).toContainText("This stops every agent the harness runs.");
    await harness.getByRole("button", { name: "Stop all", exact: true }).click();
    await expect(harness.locator("[data-harness-state]")).toHaveText("Stopped");
    await harness.getByRole("button", { name: "Start the harness" }).click();
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
  });

  test("offers a restart to update an older build", async ({ page }) => {
    const harness = await openSettings(page, "runs=empty&mockHarness=older");
    await expect(harness).toContainText("Gossamr has build 2f6c1a9e04b7.");
    await harness.getByRole("button", { name: "Restart the harness to update" }).click();
    await expect(harness).toContainText("Restarting stops every agent the harness runs.");
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
    await harness.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(harness).toContainText("Restarted.");
    await expect(harness.getByRole("button", { name: "Restart the harness to update" })).toHaveCount(0);
  });

  test("says so when it can't ask how the harness stands, and asks again", async ({ page }) => {
    const harness = await openSettings(page, "runs=empty&mockHarness=unreachable");
    await expect(harness).toContainText("Gossamr couldn't ask how the harness stands.");
    await page.evaluate(() => (globalThis as unknown as { __gossamrMock: { reachHarness(): void } }).__gossamrMock.reachHarness());
    await harness.getByRole("button", { name: "Try again" }).click();
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
  });

  test("says so when a Stop doesn't go through, and keeps what it knew", async ({ page }) => {
    const harness = await openSettings(page, "runs=empty&mockHarness=refuses");
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
    await harness.getByRole("button", { name: "Stop all agents and the harness" }).click();
    await harness.getByRole("button", { name: "Stop all", exact: true }).click();
    await expect(harness.getByRole("alert")).toHaveText("Couldn't stop the harness. Try again.");
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
  });

  test("says plainly why it can't start, and lets you try again", async ({ page }) => {
    const harness = await openSettings(page, "runs=empty&mockHarness=failed");
    await expect(harness.locator("[data-harness-state]")).toHaveText("Failed");
    await expect(harness.getByRole("alert")).toContainText("the path of its folder is too long for macOS");
    await harness.getByRole("button", { name: "Try again" }).click();
    await expect(harness.locator("[data-harness-state]")).toHaveText("Running");
  });
});
