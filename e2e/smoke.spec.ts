import { expect, test } from "@playwright/test";
import { openApp, openPip, PIP_INPUT, pipPane } from "./support/app";

test("the workspace loads with the sample tickets", async ({ page }) => {
  await openApp(page);
  const items = page.getByRole("listbox", { name: "Items" });
  await expect(items.getByRole("option").filter({ hasText: "CA-401" })).toContainText("Welcome flow refresh");
  expect(await items.getByRole("option").count()).toBeGreaterThan(1);
});

test("switching from list to board and back renders each view", async ({ page }) => {
  await openApp(page);
  const views = page.getByRole("group", { name: "View" });
  const items = page.getByRole("listbox", { name: "Items" });
  await expect(views.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await expect(items).toBeVisible();

  await views.getByRole("button", { name: "Board" }).click();
  await expect(views.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  await expect(items).toHaveCount(0);
  const boards = page.locator('section[aria-label$=" board"]');
  await expect(boards.first()).toBeVisible();
  await expect(boards.getByText("CA-401", { exact: true })).toBeVisible();

  await views.getByRole("button", { name: "List" }).click();
  await expect(boards).toHaveCount(0);
  await expect(items.getByText("CA-401", { exact: true })).toBeVisible();
});

test("clicking a ticket opens its peek, and Esc closes it", async ({ page }) => {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByRole("option").filter({ hasText: "CA-401" }).click();
  const peek = page.locator("#peek-sheet");
  await expect(peek).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(peek).toContainText("CA-401");
  await expect(peek).toContainText("Welcome flow refresh");

  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
});

test("Ctrl/Cmd+J opens Pip with its input focused, and closes it again", async ({ page }) => {
  await openApp(page);
  await expect(pipPane(page)).toHaveCount(0);
  await openPip(page);
  await expect(page.locator(PIP_INPUT)).toBeFocused();

  await page.keyboard.press("ControlOrMeta+j");
  await expect(pipPane(page)).toHaveCount(0);
});
