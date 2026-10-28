import { expect, test } from "@playwright/test";
import { agentsHome, openAgents, openApp, pauseAtCeiling, startWorkstream, workstreamGroup } from "./support/app";

test("Work shows one status and one Needs you filter for workstreams", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await pauseAtCeiling(page, "CA-401");
  await openAgents(page);
  const work = agentsHome(page);
  await expect(work.getByRole("heading", { name: "Work" })).toBeVisible();
  await expect(work.getByRole("group", { name: "Group by" })).toHaveCount(0);
  await expect(work.getByLabel("Filter by state")).toHaveCount(0);
  const group = workstreamGroup(page, "CA-401");
  await expect(group.locator("[data-status]")).toHaveText("Needs you");
  const filter = work.locator('[data-chip="needs"]');
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(group).toBeVisible();
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "false");
});

test("an agent row opens its report and offers Terminal and Stop", async ({ page }) => {
  await openApp(page);
  await openAgents(page);
  const work = agentsHome(page);
  const row = work.locator('article[data-state="working"]').first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Open in Terminal" }).last()).toBeVisible();
  await expect(row.locator("summary", { hasText: "Stop" })).toBeVisible();
  const done = work.locator('article[data-state="done"]').first();
  await done.click();
  await expect(page.locator("#agent-sheet [data-run-report]")).toBeVisible();
});

test("Inbox shows today's watched ticket activity in one list with a Mentions filter", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  const feed = page.getByRole("feed", { name: "Activity" });
  await expect(feed.locator("article").first()).toBeVisible();
  const show = page.getByRole("group", { name: "Show" });
  await expect(show.getByRole("button")).toHaveCount(2);
  await show.getByRole("button", { name: "Mentions" }).click();
  await expect(show.getByRole("button", { name: "Mentions" })).toHaveAttribute("aria-pressed", "true");
  await expect(feed.locator("article").first()).toContainText("mentioned you on");
});
