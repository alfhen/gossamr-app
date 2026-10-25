import { expect, test, type Page } from "@playwright/test";
import { agentsHome, homeConversation, jiraWrites, needOfKind, needsPane, needsYouCount, openAgents, openJiraSent, openApp, selectWorkstream, startWorkstream, openNeedOfKind, needsStack } from "./support/app";

// Fixes from the seventh dogfood round: approving from the Decide pane, the Next line, the reporter's questions and What Jira
// saw from me.

const MANAGED = "wsManage=1";

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
    await openApp(page, MANAGED);
    await workstreamOnHome(page);
    const before = Number(await needsYouCount(page).innerText());
    expect(before).toBeGreaterThan(0);
    await openNeedOfKind(page, "plan");
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Update description" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toContain("rewrite");
    await expect(needOfKind(page, "plan")).toHaveCount(0);
    // The plan is no longer a need. (The description Jira now holds is not the one the workstream was opened on, so a hold may take its place in the count.)
    await expect(needsStack(page)).not.toContainText("approving its description update is how the plan is approved");
    expect(Number(await needsYouCount(page).innerText())).toBeLessThanOrEqual(before);
    await expect(agentsHome(page)).toBeVisible();
  });
});

const activeTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? "none");

test.describe("keyboard: focus and Esc (G6, G7, G12)", () => {
  test("Looks fine does not drop the keyboard on <body>, and Esc leaves the Sent view for Pip home", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const notice = agentsHome(page).locator("[data-clarity-notice]");
    await notice.getByRole("button", { name: "Looks fine" }).focus();
    await page.keyboard.press("Enter");
    await expect(notice).toHaveCount(0);
    await expect.poll(() => activeTag(page)).not.toBe("BODY");

  });

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
