import { expect, test, type Page } from "@playwright/test";
import { askRun, openApp } from "./support/app";

// The Agents view keeps its cards where they are while the person has the pointer over the list or focus in it.

/** The Agents view's run ids, in the order the page shows them; Pip's strip of agents shows runs too, and only the view counts. */
const shownIds = (page: Page) => page.locator('main [data-run-id]:not(aside[aria-label="Pip"] *)').evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")));

async function openAgents(page: Page) {
  await openApp(page);
  await page.getByRole("button", { name: /^Agents/ }).first().click();
  await expect(page.locator("[data-agents-list]")).toBeVisible();
}

const card = (page: Page, id: string) => page.locator(`main [data-run-id="${id}"]:not(aside[aria-label="Pip"] *)`);

test("a card whose run changes state stays put while the pointer is over the list, and moves once it leaves", async ({ page }) => {
  await openAgents(page);
  const before = await shownIds(page);
  await card(page, "run-seed-4").hover();
  await expect(page.locator("[data-agents-list]")).toHaveAttribute("data-frozen", "true");
  // A running run asks a question: it belongs under Needs you now, which would take it from where it is.
  await askRun(page, "run-seed-3", "Which branch?");
  await expect(card(page, "run-seed-3")).toHaveAttribute("data-state", "needsAnswer");
  expect(await shownIds(page)).toEqual(before);
  await page.locator("main header").first().hover();
  await expect(page.locator("[data-agents-list]")).not.toHaveAttribute("data-frozen", "true");
  const after = await shownIds(page);
  expect(after).not.toEqual(before);
  expect([...after].sort()).toEqual([...before].sort());
  expect(after.indexOf("run-seed-3")).toBeLessThan(before.indexOf("run-seed-3"));
});

test("focus in the list holds the order as well, until focus leaves it", async ({ page }) => {
  await openAgents(page);
  const before = await shownIds(page);
  await card(page, "run-seed-4").focus();
  await askRun(page, "run-seed-3", "Which branch?");
  await expect(card(page, "run-seed-3")).toHaveAttribute("data-state", "needsAnswer");
  expect(await shownIds(page)).toEqual(before);
  await page.getByRole("button", { name: "Start an agent" }).first().focus();
  await expect.poll(() => shownIds(page)).not.toEqual(before);
});
