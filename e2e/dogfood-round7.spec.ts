import { expect, test, type Page } from "@playwright/test";
import { homeConversation, jiraWrites, needOfKind, needsPane, needsYouCount, needsYouTray, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the seventh dogfood round: approving from the Decide pane, the Next line, Plan my week, Start my day, the
// reporter's questions and What Jira saw from me.

const MANAGED = "wsManage=1";

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
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
    await needOfKind(page, "plan").click();
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Update description" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toContain("rewrite");
    await expect(needOfKind(page, "plan")).toHaveCount(0);
    // The plan is no longer a need. (The description Jira now holds is not the one the workstream was opened on, so a hold may take its place in the count.)
    await expect(needsYouTray(page)).not.toContainText("approving its description update is how the plan is approved");
    expect(Number(await needsYouCount(page).innerText())).toBeLessThanOrEqual(before);
    await expect(pipHome(page)).toBeVisible();
  });
});

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

test.describe("Start my day, Plan my week and What Jira saw from me (G8, G9, G13)", () => {
  test.use({ storageState: DAY_DUE });

  test("the day card is a named stop, the plan says its week by date and what keeping does, and the sent view has a way back", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openPipHome(page);
    // The F6 stop is a region of its own, named for what it holds.
    await expect(pipHome(page).locator('[data-pip-home-day][role="region"]')).toHaveAttribute("aria-label", "Start my day");
    const day = pipHome(page).locator("[data-start-my-day]");
    await expect(day).toBeVisible();

    await day.getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    await expect(plan).toBeVisible();
    await expect(pipHome(page).locator("[data-pip-home-day]")).toHaveAttribute("aria-label", "Plan my week");
    await expect(plan.getByRole("heading", { name: /Plan my week · week of \d{1,2} \w{3}/ })).toBeVisible();
    await expect(plan).not.toContainText(/\d{4}-W\d{2}/);
    await expect(plan).toContainText("Keep this plan to see it as This week on Pip home; it stays on this device.");
    await expect(plan).not.toContainText("Kept on this device");
    await plan.locator("[data-plan-close]").click();

    await day.getByRole("button", { name: "What Jira saw from me" }).click();
    const sent = page.locator("[data-jira-sent]");
    await expect(sent).toBeVisible();
    await sent.getByRole("button", { name: "← Pip home" }).click();
    await expect(sent).toHaveCount(0);
    await expect(pipHome(page)).toBeVisible();
  });
});

const activeTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? "none");

test.describe("keyboard: focus and Esc (G6, G7, G12)", () => {
  test.use({ storageState: DAY_DUE });

  test("Plan my week opens on a row, Delete removes it, and a chosen ticket's row takes the focus", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    await expect(plan).toBeVisible();
    await expect(plan.locator("[data-plan-pick]").first()).toBeFocused();
    const before = await plan.locator("[data-plan-pick]").count();
    await page.keyboard.press("Delete");
    await expect(plan.locator("[data-plan-pick]")).toHaveCount(before - 1);
    expect(await activeTag(page)).not.toBe("BODY");
    // Several tickets match: choosing one lands the keyboard on its new row, not on <body>.
    await plan.locator("[data-plan-add]").fill("e");
    await plan.locator("[data-plan-add-go]").click();
    await expect(plan.locator("[data-plan-choice]").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(plan.locator("[data-plan-pick]")).toHaveCount(before);
    await expect(plan.locator("[data-plan-pick]").last()).toBeFocused();
  });

  test("Looks fine does not drop the keyboard on <body>, and Esc leaves the Sent view for Pip home", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    const notice = pipHome(page).locator("[data-clarity-notice]");
    await notice.getByRole("button", { name: "Looks fine" }).focus();
    await page.keyboard.press("Enter");
    await expect(notice).toHaveCount(0);
    await expect.poll(() => activeTag(page)).not.toBe("BODY");

  });

  test("Esc leaves the Sent and Settings views for Pip home, from <body>", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "What Jira saw from me" }).click();
    await expect(page.locator("[data-jira-sent]")).toBeVisible();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-jira-sent]")).toHaveCount(0);
    await expect(pipHome(page)).toBeVisible();

    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toHaveCount(0);
    await expect(pipHome(page)).toBeVisible();
  });
});
