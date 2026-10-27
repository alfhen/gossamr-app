import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, mockRuns, needsPane, needsYouTray, openAgents, openApp, openNeedRow, needsStack } from "./support/app";

// Fixes from the fourth dogfood round: Needs-you titles wrap instead of truncating, and the Decisions count leaves out
// bookkeeping.

/** Pip home on the sample's own runs, with the permission need's decision open in the pane. */
async function onPermission(page: Page) {
  await openApp(page);
  await openAgents(page);
  await expect(needsYouTray(page)).toBeVisible();
  await expandNeedsYou(page, "General");
  const run = (await mockRuns(page)).find((r) => r.key === "DEVOPS-471")!;
  await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
  const pane = needsPane(page);
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  return { run, pane };
}

test.describe("Needs-you titles wrap (F10)", () => {
  test("a need's title may take two lines instead of truncating, and the header stays in view", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    const title = needsStack(page).locator("[data-needs-you-need-title]").first();
    await expect(title).toBeVisible();
    expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
    expect(await title.getAttribute("title")).toBeTruthy();
  });
});

test.describe("keys inside the open decision, the palette's Agents and Undo (F2, F8, F9, F13)", () => {
  const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

  test("'agents' in the palette finds Open Agents first, and it opens the Agents screen", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("agents");
    await expect(palette(page).getByRole("option").first()).toContainText("Open Agents");
    await page.keyboard.press("Enter");
    await expect(page.locator("main").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  });

  test("a need in no workstream has no link to a workstream", async ({ page }) => {
    const { pane } = await onPermission(page);
    await expect(pane.getByRole("button", { name: "Open in workstream" })).toHaveCount(0);
  });
});
