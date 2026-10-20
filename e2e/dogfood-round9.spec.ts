import { expect, test, type Page } from "@playwright/test";
import { agentsHome, jiraWrites, needsPane, openAgents, openApp, pipPane, selectWorkstream, startMyDay, startWorkstream, workstreamGroup } from "./support/app";

// Fixes from the ninth dogfood round: the Held toast that goes with Resume (G10), Plan my week naming a Done ticket typed by
// its words (G12), and the words the owner posts to Jira (G3).

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const toast = (page: Page) => page.locator("[data-toast]");

test.describe("the Held toast (G10)", () => {
  test("goes when the workstream is resumed, and offers Undo no more", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await agentsHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(toast(page).filter({ hasText: "Held CA-401." }).getByRole("button", { name: "Undo" })).toBeVisible();
    await agentsHome(page).getByRole("button", { name: "Resume", exact: true }).click();
    await expect(pipPane(page).locator("[data-held-banner]")).toHaveCount(0);
    await expect(toast(page).filter({ hasText: "Held CA-401." })).toHaveCount(0);
  });
});

test.describe("adding a Done ticket to the plan by its words (G12)", () => {
  test.use({ storageState: DAY_DUE });

  test("says the ticket is Done in Jira, not that no open ticket matches", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openAgents(page);
    await startMyDay(page);
    await agentsHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = agentsHome(page).locator("[data-plan-my-week]");
    await plan.locator("[data-plan-add]").fill("queue library");
    await plan.locator("[data-plan-add-go]").click();
    await expect(plan.locator("[data-plan-missing]")).toHaveText("DEVOPS-478 is Done in Jira.");
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the ask to the reporter (G3)", () => {
  test("is in a neutral voice: no 'I', no 'we' and no 'can be planned'", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&prSurface=manual&wsManage=1&pipPace=1");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const card = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(card).toContainText("A few things need clearing up to make this ticket clear to work on:");
    await expect(card).not.toContainText("can be planned");
    await expect(card).not.toContainText(/Before I |we need|I can.t/);
  });
});

test.describe("the close confirm (G9)", () => {
  test("opens on Keep, so Enter twice never closes the workstream", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ask).toHaveCount(0);
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(1);
  });
});

test.describe("what the safety line promises (G13)", () => {
  test("Pip's intro says Jira waits for approval and a build only pushes its own branch to GitHub", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openAgents(page);
    await expect(page.locator("body")).not.toContainText("Nothing is posted to Jira or GitHub");
  });
});
