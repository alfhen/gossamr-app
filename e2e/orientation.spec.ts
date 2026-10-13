import { expect, test, type Page } from "@playwright/test";
import { openApp, pipHome, workstreamRow } from "./support/app";

/** Pip home's orientation card. */
const card = (page: Page) => page.locator("[data-pip-orientation]");
const rail = (page: Page) => page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) });

test.describe("rail names", () => {
  test("a rail button shows its name, and its shortcut, on hover and on keyboard focus", async ({ page }) => {
    await openApp(page, "runs=empty");
    const search = rail(page).getByRole("button", { name: "Search and jump" });
    await search.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/^Search and jump\s*⌘K$/);
    await page.mouse.move(700, 500);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await search.focus();
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("button", { name: "All projects" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("All projects");

    const settings = rail(page).getByRole("button", { name: "Settings" });
    await expect(settings).toHaveAttribute("aria-label", "Settings");
    await settings.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Settings");
  });

  test("only the hovered button's tooltip shows while another rail button has keyboard focus", async ({ page }) => {
    await openApp(page, "runs=empty");
    await rail(page).getByRole("button", { name: "Search and jump" }).focus();
    await page.keyboard.press("Tab");
    const focused = rail(page).getByRole("button", { name: "All projects" });
    await expect(focused).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("All projects");

    await rail(page).getByRole("button", { name: "Settings" }).hover();
    const tips = page.getByRole("tooltip");
    await expect(tips.filter({ visible: true })).toHaveCount(1);
    await expect(tips.filter({ visible: true })).toHaveText("Settings");

    // The pointer leaves the rail, and the keyboard's tooltip comes back.
    await page.mouse.move(700, 500);
    await expect(tips.filter({ visible: true })).toHaveText("All projects");
    await expect(tips.filter({ visible: true })).toHaveCount(1);
  });
});

test.describe("first-run orientation", () => {
  // The config seeds the card dismissed for every other spec; here the profile is a first run.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows on Pip home the first time, says what the words mean, and Got it hides it for good", async ({ page }) => {
    await page.goto("/?runs=empty");
    await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
    const orientation = card(page);
    await expect(orientation).toBeVisible();
    await expect(orientation).toContainText("One ticket's work from start to pull request");
    await expect(orientation).toContainText("One Claude Code agent session doing a step: investigate, plan, build or review");
    await expect(orientation).toContainText("The run's own checkout of your repository");
    await expect(orientation).toContainText("Nothing is posted to Jira or GitHub until you click to approve it.");

    // It takes no focus, and Pip home's keys and footer hints are as they were.
    await expect(orientation.getByRole("button", { name: "Got it" })).not.toBeFocused();
    await expect(pipHome(page).locator("[data-pip-home-hints]")).toContainText("next region");
    await expect(workstreamRow(page, "General")).toHaveAttribute("aria-selected", "true");

    await orientation.getByRole("button", { name: "Got it" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(workstreamRow(page, "General")).toBeVisible();

    await page.reload();
    await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test("Got it from the keyboard leaves focus on Pip home's list", async ({ page }) => {
    await page.goto("/?runs=empty");
    await expect(card(page)).toBeVisible();
    await card(page).getByRole("button", { name: "Got it" }).focus();
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveCount(0);
    await expect(workstreamRow(page, "General")).toBeFocused();
  });
});
