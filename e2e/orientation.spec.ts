import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

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

