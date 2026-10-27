import { expect, test, type Page } from "@playwright/test";
import { agentsHome, homeConversation, jiraWrites, needOfKind, needsPane, needsYouCount, openAgents, openJiraSent, openApp, selectWorkstream, startWorkstream, openNeedOfKind } from "./support/app";

// Fixes from the seventh dogfood round: approving from the Decide pane and Esc leaving the Sent and Settings views.


/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

test.describe("approving from the Decide pane (G1)", () => {
  test("'Update description' on the plan's decision approves it: the draft leaves, Needs you drops by one, Jira gets the edit", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await workstreamOnHome(page);
    const before = Number(await needsYouCount(page).innerText());
    expect(before).toBeGreaterThan(0);
    await openNeedOfKind(page, "plan");
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toContain("rewrite");
    await expect(needOfKind(page, "plan")).toHaveCount(0);
    // The plan is no longer a need.
    expect(Number(await needsYouCount(page).innerText())).toBeLessThanOrEqual(before);
    await expect(agentsHome(page)).toBeVisible();
  });
});

test.describe("keyboard: Esc (G7, G12)", () => {
  test("Esc leaves the Sent and Settings views for Pip home, from <body>", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openAgents(page);
    await openJiraSent(page);
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-jira-sent]")).toHaveCount(0);
    await expect(agentsHome(page)).toBeVisible();

    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toHaveCount(0);
    await expect(agentsHome(page)).toBeVisible();
  });
});
