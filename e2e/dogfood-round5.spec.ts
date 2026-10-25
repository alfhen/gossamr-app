import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, expandNeedsYou, mockRuns, needOfKind, needsPane, needsPaneHeading, openAgents, openApp, selectWorkstream, startWorkstream, stepChip, openNeedOfKind, openNeedRow, groupOpen, needsStack, paneSettled as settled } from "./support/app";

// Fixes from the fifth dogfood round: Needs you on Pip home shows each need once, an unclear ticket's "Ask the reporter" lands
// on the new draft, and Plan is not "Next" while the ticket waits for a choice.

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
  test("Plan is not Next while it waits for the choice", async ({ page }) => {
    await unclear(page);
    await expect(stepChip(page, "plan")).toContainText("Waiting for your choice: ticket unclear");
    await expect(stepChip(page, "plan").locator("[data-step-next]")).toHaveCount(0);
    await expect(agentsHome(page).getByRole("button", { name: "Plan this" })).toHaveCount(0);
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

test.describe("the permission panel says what Deny does (G11)", () => {
  test("says it under the buttons; a read-only run's Deny needs no confirm", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
    const pane = needsPane(page);
    await expect(pane.locator("[data-permission-ask]")).toContainText("Claude is told you said no");
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(pane.getByRole("group", { name: "Deny this request" })).toHaveCount(0);
  });
});

