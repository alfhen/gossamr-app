import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, backdateWorkstream, expandNeedsYou, expectVisibleFocus, holdBySystem, homeSettled, jiraWrites, mockRuns, needOfKind, needRow, needsPane, needsPaneHeading, needsYouRow, needsYouTray, openApp, openPipHome, paneSettled as settled, pipHome, seedWorkstreamEvent, startWorkstream, stepChip, workstreamRow } from "./support/app";

// Fixes from the fifth dogfood round: Needs you on Pip home shows each need once, an unclear ticket's "Ask the reporter" lands
// on the new draft, Plan is not "Next" while the ticket waits for a choice, and a cobweb says what it is on the row.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

async function startInvestigation(page: Page, key: string) {
  await settled(page);
  await askPip(page, "investigate this");
  await settled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('aside[aria-label="Pip"]').getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
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
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("Needs you on Pip home (G5)", () => {
  test("opens each group by default, so every need shows once under a header that is only its name and count", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await expect(needsYouTray(page)).toBeVisible();
    const group = needsYouRow(page, "General");
    const more = group.locator("[data-needs-you-more]");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(group.locator("[data-needs-you-need]").first()).toBeVisible();
    // Open, the header does not say the top need's why again.
    await expect(group.locator("[data-needs-you-why]")).toHaveCount(0);
    await expect(group.locator("[data-needs-you-count-chip]")).toContainText(/\d+ here/);
    // The person's fold is kept.
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator("[data-needs-you-need]")).toHaveCount(0);
    await expandNeedsYou(page, "General");
    // The chips say what they mean.
    await expect(needsYouTray(page).locator("[data-needs-you-chip]").first()).toHaveAttribute("title", /^(Decide|Unblock|Approve): /);
  });
});

test.describe("a ticket stopped as unclear (G2, G3)", () => {
  test("Plan is not Next while it waits for the choice, and the chip asks what is unclear instead of offering the Plan", async ({ page }) => {
    await unclear(page);
    await expect(stepChip(page, "plan")).toContainText("Waiting for your choice: ticket unclear");
    await expect(stepChip(page, "plan").locator("[data-step-next]")).toHaveCount(0);
    await expect(pipHome(page).getByRole("button", { name: "Plan this" })).toHaveCount(0);
    await expect(pipHome(page).getByRole("button", { name: "What is unclear about this ticket?" })).toBeVisible();
  });

  test("Ask the reporter opens the questions draft in the decision pane, not the next need, and posts nothing", async ({ page }) => {
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "draft");
    await expect(pane).toContainText("A few things about CA-408 need clearing up");
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
    await openPipHome(page);
    await homeSettled(page);
    const row = workstreamRow(page, "CA-402");
    // The sample's runs are going, and Running ranks above Quiet; the cobweb itself (drawn, titled, said) is unchanged.
    await expect(row.locator("[data-status]")).toHaveText("Running");
    await expect(row.locator("[data-workstream-wither]")).toHaveText(/^No Jira update for 6 days/);
    await expect(row).toHaveAttribute("title", /^No Jira update for 6 days/);
  });
});

/** A managed workstream on CA-401 with one comment draft of Pip's waiting as a need, on Pip home. */
async function draftNeed(page: Page) {
  await openApp(page, "runs=empty&wsManage=1");
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  // A restart's hold keeps the draft from being the only need, so the pane has somewhere to move on to.
  await holdBySystem(page, "CA-401", "restart");
  await expect(needRow(page, /Draft comment/)).toBeVisible();
}

const undoToast = (page: Page) => page.locator("[data-toast]").getByRole("button", { name: "Undo" });

test.describe("undoing a skip by key (G6)", () => {
  test("Ctrl/Cmd+Z takes the skip back and opens the restored draft in the pane", async ({ page }) => {
    await draftNeed(page);
    const row = needRow(page, /Draft comment/);
    await row.focus();
    await page.keyboard.press("s");
    await expect(row).toHaveCount(0);
    await expect(undoToast(page)).toBeVisible();

    await page.keyboard.press("ControlOrMeta+z");
    await expect(row).toBeVisible();
    await expect(undoToast(page)).toHaveCount(0);
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "draft");
    await expect(pane.locator("article[data-draft]")).toBeVisible();
    // Nothing more to undo: the key does nothing.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(pane).toBeVisible();
  });
});

test.describe("the decision pane's keys (G7)", () => {
  test("opening a draft lands on the pane's heading, so approving takes a and then Enter; e goes into the text; Esc ends the edit before it closes the pane", async ({ page }) => {
    await draftNeed(page);
    const row = needRow(page, /Draft comment/);
    await row.focus();
    await page.keyboard.press("Enter");
    const pane = needsPane(page);
    await expect(needsPaneHeading(page)).toBeFocused();
    expect(await jiraWrites(page)).toEqual([]);

    // e (from the row) opens the edit with the text focused.
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(row).toBeFocused();
    await page.keyboard.press("e");
    await expect(pane.locator("textarea")).toBeFocused();
    await page.keyboard.type(" Edited.");
    // Esc leaves the field, the next one ends the edit with the text kept, the one after closes.
    await page.keyboard.press("Escape");
    await expect(pane.locator("textarea")).not.toBeFocused();
    await expect(pane).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pane.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(pane).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("one line for one post (G8)", () => {
  test("an approved draft is one line of the timeline, and the Decisions count still has it", async ({ page }) => {
    await draftNeed(page);
    await needRow(page, /Draft comment/).click();
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
    const lines = pipHome(page).locator('[data-timeline-entry][aria-label^="You approved a comment"]');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveAttribute("data-kind", "draft");
    await expect(lines.first()).toHaveAttribute("aria-label", /: posted$/);
    await expect(pipHome(page).locator('[data-timeline-entry][data-kind="audit"][aria-label="You approved a comment on CA-401"]')).toHaveCount(0);
    await expect(pipHome(page).locator('[data-filter="decisions"]').first().locator("[data-filter-count]")).not.toHaveText("0");
  });
});

test.describe("the last timeline entry shows the keyboard (G12)", () => {
  test("an audit line takes a visible focus ring", async ({ page }) => {
    await draftNeed(page);
    const entry = pipHome(page).locator('[data-timeline-entry][data-kind="audit"]').last();
    await expect(entry).toBeVisible();
    await page.keyboard.press("Tab");
    await entry.focus();
    await expect(entry).toBeFocused();
    await expectVisibleFocus(page);
    expect(await entry.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
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
    await openPipHome(page);
    await expandNeedsYou(page, "General");
    await needRow(page, /DEVOPS-471.*asks to run a command/).click();
    const pane = needsPane(page);
    await expect(pane.locator("[data-permission-explainer]")).toContainText("What Deny does");
    await expect(pane.locator("[data-permission-ask]")).not.toContainText("Claude is told you said no");
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(pane.getByRole("group", { name: "Deny this request" })).toHaveCount(0);
    await expect(pane.locator("[data-permission-explainer]")).toHaveCount(0);
  });
});
