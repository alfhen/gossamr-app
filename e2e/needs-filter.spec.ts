import { expect, test, type Page } from "@playwright/test";
import { agentsHome, closePipDrawer, groupOpen, holdBySystem, needsPane, needsStack, needsYouCount, openAgents, openApp, openNeedOfKind, startWorkstream, workstreamGroup, workstreamSheet } from "./support/app";

// Needs you is a filter on Agents, and each workstream's needs are at the top of its detail (docs/needs-you.md).

const MANAGED = "wsManage=1";

const chip = (page: Page, name: string) => agentsHome(page).locator(`[data-chip="${name}"]`);
const railBadge = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Agents/ });

async function withNeeds(page: Page, calm = false) {
  await openApp(page, MANAGED);
  if (calm) await startWorkstream(page, "CA-402");
  await startWorkstream(page, "CA-401");
  // A restart's hold is a need of the system's; the sample leaves CA-401's plan to approve and General's own needs.
  await holdBySystem(page, "CA-401", "restart");
  await openAgents(page);
  await closePipDrawer(page);
}

test("the Needs you chip is a toggle whose count is the rail badge's, and it filters the list to what needs you", async ({ page }) => {
  await withNeeds(page, true);
  const count = Number(await needsYouCount(page).innerText());
  expect(count).toBeGreaterThan(1);
  await expect(railBadge(page)).toHaveAccessibleName(`Agents, ${count} things need you`);
  await expect(chip(page, "all")).toHaveAttribute("aria-pressed", "true");

  // A calm workstream stays in the list until the filter is on.
  await expect(workstreamGroup(page, "CA-402")).toBeVisible();

  await chip(page, "needs").click();
  await expect(chip(page, "needs")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "all")).toHaveAttribute("aria-pressed", "false");
  await expect(workstreamGroup(page, "CA-401")).toBeVisible();
  await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toBeVisible();
  await expect(workstreamGroup(page, "CA-402")).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(count));

  // Pressing it again, or All, shows everything again.
  await chip(page, "needs").click();
  await expect(chip(page, "all")).toHaveAttribute("aria-pressed", "true");
  await expect(workstreamGroup(page, "CA-402")).toBeVisible();
  await chip(page, "needs").click();
  await chip(page, "all").click();
  await expect(workstreamGroup(page, "CA-402")).toBeVisible();
  await expect(chip(page, "needs")).toHaveAttribute("aria-pressed", "false");
});

test("the lane chips are the State filter, and Clear puts every chip back to All", async ({ page }) => {
  await withNeeds(page);
  await chip(page, "bad").click();
  await expect(agentsHome(page).getByLabel("Filter by state")).toHaveValue("bad");
  await expect(chip(page, "bad")).toHaveAttribute("aria-pressed", "true");
  await agentsHome(page).getByLabel("Filter by state").selectOption("done");
  await expect(chip(page, "review")).toHaveAttribute("aria-pressed", "true");
  await chip(page, "needs").click();
  await expect(agentsHome(page).getByLabel("Filter by state")).toHaveValue("all");
  await agentsHome(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(chip(page, "all")).toHaveAttribute("aria-pressed", "true");
});

test("a workstream with needs shows a badge and an accent in the list, with no filter on, and a calm one does not", async ({ page }) => {
  await withNeeds(page, true);
  const busy = workstreamGroup(page, "CA-401");
  await expect(busy).toHaveAttribute("data-has-needs", "");
  await expect(busy.locator("[data-needs-you-badge]")).toContainText(/\d+ needs? you|\d+ need you/);
  const calm = workstreamGroup(page, "CA-402");
  await expect(calm).not.toHaveAttribute("data-has-needs", "");
  await expect(calm.locator("[data-needs-you-badge]")).toHaveCount(0);
  await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toHaveAttribute("data-has-needs", "");
});

test("opening a workstream puts its needs at the top of the detail, most urgent first, the first one open", async ({ page }) => {
  await withNeeds(page);
  await groupOpen(page, "CA-401").click();
  const sheet = workstreamSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Needs you" })).toBeVisible();
  const items = needsStack(page).locator("[data-needs-pane]");
  expect(await items.count()).toBeGreaterThan(1);
  // A decision (the plan) outranks what is stuck (the hold).
  await expect(items.first()).toHaveAttribute("data-group", "decide");
  await expect(items.first()).toHaveAttribute("data-open", "true");
  await expect(items.nth(1)).toHaveAttribute("data-kind", "hold");
  await expect(items.nth(1)).not.toHaveAttribute("data-open", "true");
  // It sits above the steps and runs.
  const above = await needsStack(page).evaluate((el) => !!(el.compareDocumentPosition(document.querySelector("#workstream-sheet [data-step-rail]")!) & Node.DOCUMENT_POSITION_FOLLOWING));
  expect(above).toBe(true);
  await expect(needsPane(page)).toHaveCount(1);

  // Opening the second one closes the first.
  await items.nth(1).locator("[data-need-key]").click();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
  await expect(needsPane(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(items.first()).not.toHaveAttribute("data-open", "true");
});

test("a need in no workstream opens No workstream, which works the same way and is reachable with the filter on", async ({ page }) => {
  await withNeeds(page);
  await chip(page, "needs").click();
  const none = agentsHome(page).locator('[data-workstream-group="none"]');
  await expect(none.locator("[data-needs-you-badge]")).toBeVisible();
  await groupOpen(page, "General").click();
  await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
  await expect(needsPane(page)).toBeVisible();
  await expect(needsStack(page).locator("[data-needs-pane]").first()).toHaveAttribute("data-open", "true");
});

test("the badge popover's item turns the filter on and opens that workstream's detail with the need open", async ({ page }) => {
  await withNeeds(page);
  await expect(chip(page, "needs")).toHaveAttribute("aria-pressed", "false");
  await openNeedOfKind(page, "hold");
  await expect(chip(page, "needs")).toHaveAttribute("aria-pressed", "true");
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
});

test("j and k still walk the runs and Enter opens one", async ({ page }) => {
  await openApp(page, MANAGED);
  await openAgents(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  const first = agentsHome(page).locator("article[data-run-id]").first();
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#agent-sheet")).toBeVisible();
});
