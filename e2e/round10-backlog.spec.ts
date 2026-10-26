import { expect, test, type Page } from "@playwright/test";
import { agentsHome, openAgents, openApp, selectWorkstream, startWorkstream, stepRail } from "./support/app";

// Fixes from round 10's backlog: the workstream controls on the steps rail's F6 stop (G27), Ctrl+0 on Pip home going on to General (G28), "N here" on a Needs you group (G30), the palette's
// note (G31) and the toasts leaving with the page and clearing the launcher (G32).

const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** A workstream on `key`, begun from its peek, and Pip home on it. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

test.describe("what the palette says (G31)", () => {
  test("'Start a workstream' says it starts no agent and posts nothing", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    await agentsHome(page).getByRole("button", { name: "Start a workstream…" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.locator("[data-palette-note]")).toHaveText("Opens a workstream; starts no agent and posts nothing.");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-palette-note]")).toHaveCount(0);
  });

});

test.describe("toasts leave with the page and clear the launcher (G32)", () => {
  test("one without Undo is dismissed when the route changes", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await begin(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const rail = stepRail(page);
    await rail.getByRole("button", { name: "Close…" }).click();
    await rail.getByRole("button", { name: "Close workstream" }).click();
    await expect(toast(page)).toContainText("Closed the workstream on CA-408");
    // Close has an Undo now (round 13, G23); the toast that says it was undone has none.
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Reopened the workstream on CA-408");
    await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    // A toast younger than the route grace (500 ms) is taken to come with the change and stays; leave it older than that.
    await page.waitForTimeout(700);
    await allProjects(page);
    await expect(agentsHome(page)).toHaveCount(0);
    await expect(toast(page)).toHaveCount(0);
  });

  test("on the workspace a toast stands above the Pip launcher, not over it", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    // A toast over the workspace (here, from drafting a ticket in the palette) clears the launcher's box.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("New ticket");
    await page.getByRole("option", { name: /^New ticket/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    if (await dialog.getByRole("option").count()) await dialog.getByRole("option").first().click();
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("Check the toast");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText("Drafted a new ticket");
    const t = (await toast(page).boundingBox())!;
    // Neither the launcher's box nor the thread its spider hangs from.
    const thread = (await launcher.locator(".pip-thread").boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual((await launcher.boundingBox())!.y);
    expect(t.y + t.height).toBeLessThanOrEqual(thread.y);
  });
});
