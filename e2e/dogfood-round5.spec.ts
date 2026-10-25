import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, backdateWorkstream, expandNeedsYou, homeSettled, mockRuns, needOfKind, needsPane, needsPaneHeading, openAgents, openApp, pipPane, seedWorkstreamEvent, selectWorkstream, startWorkstream, stepChip, workstreamGroup, openNeedOfKind, openNeedRow, groupOpen, needsStack, paneSettled as settled } from "./support/app";

// Fixes from the fifth dogfood round: Needs you on Pip home shows each need once, an unclear ticket's "Ask the reporter" lands
// on the new draft, Plan is not "Next" while the ticket waits for a choice, and a cobweb says what it is on the row.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

async function startInvestigation(page: Page, key: string) {
  await settled(page);
  await askPip(page, "investigate this");
  await settled(page);
  await page.locator('aside[aria-label="Pip"]').getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** A managed workstream on the vague ticket whose triage stopped it as unclear; left on Pip home, on its row. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
  await finish(page, (await newest(page, "triage"))!.id);
  await openAgents(page);
  await selectWorkstream(page, VAGUE);
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("Needs you on Pip home (G5)", () => {
  test("opens No workstream's detail with every need listed once, the first one open, each with a chip that says what it means", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await groupOpen(page, "General").click();
    const items = needsStack(page).locator("[data-needs-pane]");
    await expect(items.nth(1)).toBeVisible();
    await expect(items.first()).toHaveAttribute("data-open", "true");
    await expect(needsPane(page)).toHaveCount(1);
    await expect(needsStack(page).locator("[data-needs-you-chip]").first()).toHaveAttribute("title", /^(Decide|Unblock|Approve): /);
  });
});

test.describe("a ticket stopped as unclear (G2, G3)", () => {
  test("Plan is not Next while it waits for the choice, and the chip asks what is unclear instead of offering the Plan", async ({ page }) => {
    await unclear(page);
    await expect(stepChip(page, "plan")).toContainText("Waiting for your choice: ticket unclear");
    await expect(stepChip(page, "plan").locator("[data-step-next]")).toHaveCount(0);
    await expect(agentsHome(page).getByRole("button", { name: "Plan this" })).toHaveCount(0);
    await expect(pipPane(page).getByRole("button", { name: "What is unclear about this ticket?" })).toBeVisible();
  });

  test("Ask the reporter opens the questions draft in the decision pane, not the next need, and posts nothing", async ({ page }) => {
    await unclear(page);
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "draft");
    await expect(pane).toContainText("A few things need clearing up to make this ticket clear to work on");
    // The pane's heading has focus, not Post comment, so one more key cannot post it.
    await expect(needsPaneHeading(page)).toBeFocused();
  });
});

test.describe("the cobweb says what it is (G4)", () => {
  test("a row shows 'No Jira update' and its days, and keeps the sentence for a screen reader", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-402");
    await startInvestigation(page, "CA-402");
    await advanceRuns(page, 2, (await newest(page, "investigate"))!.id);
    const ago = new Date(Date.now() - 6 * 86_400_000).toISOString();
    await seedWorkstreamEvent(page, "CA-402", { actor: "person", action: "review_posted", at: ago });
    await backdateWorkstream(page, "CA-402", 6);
    await openAgents(page);
    await homeSettled(page);
    const row = workstreamGroup(page, "CA-402");
    // The sample's runs are going, and Running ranks above Quiet; the cobweb itself (drawn, titled, said) is unchanged.
    await expect(row.locator("[data-status]")).toHaveText("Running");
    await expect(row.locator("[data-workstream-wither]")).toHaveText(/^No Jira update for 6 days/);
    await expect(row.locator("[data-workstream-wither]")).toHaveAttribute("title", /^No Jira update for 6 days/);
  });
});



test.describe("the permission panel says what Deny does once (G11)", () => {
  // The first prompt the person ever sees: the config's seeded profile has the explainer dismissed, so this one starts without.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const prefs = JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}");
      localStorage.setItem("gossamr-prefs", JSON.stringify({ ...prefs, permissionExplainerSeen: false }));
    });
  });

  test("with the explainer up the note under the buttons is gone; a read-only run's Deny needs no confirm", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
    const pane = needsPane(page);
    await expect(pane.locator("[data-permission-explainer]")).toContainText("What Deny does");
    await expect(pane.locator("[data-permission-ask]")).not.toContainText("Claude is told you said no");
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(pane.getByRole("group", { name: "Deny this request" })).toHaveCount(0);
    await expect(pane.locator("[data-permission-explainer]")).toHaveCount(0);
  });
});
