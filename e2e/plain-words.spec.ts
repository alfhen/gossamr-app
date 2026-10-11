import { expect, test, type Page } from "@playwright/test";
import { agentsSettled, openApp, openPipHome, pipHome } from "./support/app";

/**
 * No three-figure hour count anywhere the person can read. (That a held workstream never says "tripwire" is checked
 * where one is held for real, in basis-drift.spec.ts.)
 */
async function plainWords(page: Page) {
  await expect(page.locator("body")).not.toContainText(/Quiet for \d{3,} h|\b\d{3,} h\b/);
}

test("the Agents view and Pip home say how long a run has been quiet in days, never in hundreds of hours", async ({ page }) => {
  // The sample runs' ages count back from when the page opened; ten days on, the working CA-377 run (quiet for 40 minutes
  // then) has been quiet for over 240 hours.
  await page.clock.install();
  await openApp(page);
  await agentsSettled(page);
  await page.clock.setSystemTime(Date.now() + 10 * 24 * 60 * 60_000);
  await page.getByRole("button", { name: /^Agents/ }).click();
  const quiet = page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)', { hasText: "CA-377" });
  await expect(quiet.first()).toContainText(/Quiet for \d+ days/);
  await plainWords(page);

  await openPipHome(page);
  await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
  await plainWords(page);
});
