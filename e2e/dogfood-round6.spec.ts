import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the sixth dogfood round: Start my day and Plan my week leave the timeline its room and Start my day is General's
// alone, the status words are explained, and the Plan my week add box says why a ticket was not added.

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const plan = (page: Page) => pipHome(page).locator("[data-plan-my-week]");
const card = (page: Page) => pipHome(page).locator("[data-start-my-day]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("Start my day and Plan my week on Pip home (G4, G9, G10)", () => {
  test.use({ storageState: DAY_DUE });

  test("the card says what it is, the plan replaces it, and neither crowds the timeline's filter bar or the chips", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator("[data-day-about]")).toContainText("Nothing is posted. Done for now hides it until tomorrow");
    await expect(card(page).locator("[data-day-done]")).toHaveAttribute("title", /until tomorrow/);

    await card(page).getByRole("button", { name: "Plan my week" }).click();
    await expect(plan(page)).toBeVisible();
    // The card steps aside while the plan is open, and comes back with its Close.
    await expect(card(page)).toHaveCount(0);
    const filter = pipHome(page).locator("[data-timeline-filter]");
    await expect(filter).toBeVisible();
    const chips = pipHome(page).getByRole("button", { name: "Catch me up" });
    await expect(chips).toBeVisible();
    const [bar, chip] = [await filter.boundingBox(), await chips.boundingBox()];
    expect(bar && chip && (chip.y >= bar.y + bar.height || chip.y + chip.height <= bar.y)).toBe(true);
    await plan(page).locator("[data-plan-close]").click();
    await expect(plan(page)).toHaveCount(0);
    await expect(card(page)).toBeVisible();
  });

  test("F6 stops on the day card while it shows, and passes it once Done for now hid it (G3)", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await expect(card(page)).toBeVisible();
    await workstreamRow(page, "General").focus();
    await page.keyboard.press("F6");
    await expect(card(page)).toBeFocused();
    await page.keyboard.press("F6");
    await expect(pipHome(page).locator("[data-timeline]")).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-timeline]"))).toBe(true);
    // Open, Plan my week is the stop in its place.
    await card(page).getByRole("button", { name: "Plan my week" }).click();
    await workstreamRow(page, "General").focus();
    await page.keyboard.press("F6");
    await expect(plan(page)).toBeFocused();
    await plan(page).locator("[data-plan-close]").click();
    await card(page).locator("[data-day-done]").click();
    await expect(card(page)).toHaveCount(0);
    await workstreamRow(page, "General").focus();
    await page.keyboard.press("F6");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-timeline]"))).toBe(true);
  });

  test("a workstream's own conversation has no Start my day card above its timeline", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await expect(pipHome(page).locator('[data-pip-conversation^="ws:"]')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});

test.describe("status words explained (G6)", () => {
  test("a row's pill and the header's pill carry what the word means", async ({ page }) => {
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-402");
    await openPipHome(page);
    const pill = workstreamRow(page, "CA-402").locator("[data-status]");
    await expect(pill).toHaveText("Idle");
    await expect(pill).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    // The same words are in the row as text for a screen reader, which the pill is described by.
    await expect(workstreamRow(page, "CA-402").locator("[data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
    await expect(pill).toHaveAttribute("aria-describedby", /.+/);
    await workstreamRow(page, "CA-402").click();
    await expect(pipHome(page).locator("[data-header-status]")).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    await expect(pipHome(page).locator("[data-header-status] [data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
  });
});

test.describe("the Plan my week add box (G12)", () => {
  test.use({ storageState: DAY_DUE });

  test("says a ticket is in the plan already, differently from no match, and names what a word match added", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await card(page).getByRole("button", { name: "Plan my week" }).click();
    const add = plan(page).locator("[data-plan-add]");
    await add.fill("CA-999");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(plan(page).locator("[data-plan-missing]")).toHaveText("No open ticket matches that.");
    await add.fill("CA-208");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(plan(page).locator("[data-plan-added]")).toContainText("Added CA-208");
    await add.fill("CA-208");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(plan(page).locator("[data-plan-missing]")).toHaveText("CA-208 is in the plan already.");
    expect(await jiraWrites(page)).toEqual([]);
  });
});
