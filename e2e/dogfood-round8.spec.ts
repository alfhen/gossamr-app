import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, commentOnTicket, holdBySystem, homeSettled, jiraWrites, mockRuns, needsPane, needsYouRow, needsYouTray, openApp, openPipHome, paneSettled as settled, peekSheet, peekTicket, pipHome, pipPane, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the eighth dogfood round: what the Decide pane's line says was posted, where the pane goes after the last need,
// the left column's heights, the timeline's words for asks and rule-started runs, and the plan draft's Build.

test.describe("the Decide pane's Done line (G5)", () => {
  test("says a posted comment was posted to Jira, and names the next need's ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await needsYouTray(page).locator("[data-needs-you-group], [data-needs-you-need]").filter({ hasText: /Pip drafted a comment/ }).first().click();
    await holdBySystem(page, "CA-401", "restart");
    await expect(needsYouRow(page, "CA-401")).toContainText("Held after a restart");
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Held after a restart$/);
  });
});

test.describe("the left column's heights (G7)", () => {
  test("Needs you takes what it needs, and the Workstreams list takes the rest", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    const left = await pipHome(page).locator("[data-pip-home-left]").boundingBox();
    const needs = await needsYouTray(page).boundingBox();
    const list = await pipHome(page).getByRole("navigation", { name: "Workstreams" }).boundingBox();
    expect(left && needs && list).toBeTruthy();
    expect(needs!.height).toBeLessThanOrEqual(left!.height * 0.5 + 1);
    expect(list!.height).toBeGreaterThan(needs!.height);
  });
});

const SUPERVISED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });

/** Moves run `id` on to done, once Pip has finished answering. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** The id of the newest run of `kind`, once a rule has started one. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.kind === kind)?.id ?? null).not.toBeNull();
  return (await mockRuns(page)).find((r) => r.kind === kind)!.id;
}

test.describe("the plan's description draft and the build it starts (G3, G2)", () => {
  test("says approving can start a Build, and the timeline then says Gossamr started it after the plan's approval", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, SUPERVISED);
    await startWorkstream(page, "CA-401");
    await settled(page);
    await askPip(page, "investigate this");
    await settled(page);
    for (let attempt = 0; attempt < 2; attempt++) {
      await pipPane(page).getByRole("article", { name: "Start an agent: CA-401" }).last().getByRole("button", { name: "Review and start →" }).click();
      await expect(setup(page).or(safety(page))).toBeVisible();
      if (!(await safety(page).isVisible())) break;
      await safety(page).getByRole("button", { name: "Close" }).click();
    }
    await setup(page).getByRole("button", { name: "Start agent" }).click();
    await expect(setup(page)).toHaveCount(0);
    await finish(page, await started(page, "investigate"));
    await finish(page, await started(page, "triage"));
    await finish(page, await started(page, "plan"));
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
    const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
    await expect(draft.locator("[data-approval-starts-build]")).toContainText("Approving this can start a Build: it changes code in its own worktree and runs with your Claude settings.");
    await draft.getByRole("button", { name: "Update description" }).click();
    await expect(draft).toHaveCount(0);
    await started(page, "build");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(pipHome(page).locator("[data-timeline-line]").filter({ hasText: "Gossamr started the build run automatically on CA-401 after you approved the plan" })).toHaveCount(1);
  });
});

test.describe("the timeline's words for a posted ask (G13)", () => {
  test("a posted reporter ask is 'You posted the questions for the reporter', not a plain comment", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&prSurface=manual&wsManage=1&pipPace=1");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await expect(pipHome(page).locator("[data-timeline-line]").filter({ hasText: "You posted the questions for the reporter on CA-408" })).toHaveCount(1);
  });
});

test.describe("the reporter's reply stays in the timeline (G1, G12, G13)", () => {
  test("a reply that ended the wait is still there once the person asks again, and a reply of two lines is quoted on both (G27 of round 12)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    const notice = pipHome(page).locator("[data-clarity-notice]");
    const askAndPost = async (posted: number) => {
      await notice.getByRole("button", { name: "Ask the reporter now" }).click();
      await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
      await expect.poll(async () => (await jiraWrites(page)).filter((w) => w.type === "comment").length).toBe(posted);
    };
    await askAndPost(1);
    await commentOnTicket(page, "CA-408", "It should send three emails.\nOne to the shopper, two to support.");
    const lines = pipHome(page).locator("[data-timeline] [data-timeline-line]");
    const reply = lines.filter({ hasText: "The reporter replied on the ticket" });
    await expect(reply.locator("[data-timeline-detail]")).toHaveText("“It should send three emails. One to the shopper, two to support.”");
    await askAndPost(2);
    // Asking again ended the wait the reply ended, but the reply stays, between the two asks.
    await expect(reply).toHaveCount(1);
    await expect(lines.filter({ hasText: "You posted the questions for the reporter on CA-408" })).toHaveCount(1);
    await expect(lines.filter({ hasText: "You posted the follow-up questions for the reporter on CA-408" })).toHaveCount(1);
  });
});

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

test.describe("This week is a keyboard stop (G8, G9)", () => {
  test.use({ storageState: DAY_DUE });

  test("F6 lands in This week, and opening an item hands the keyboard to its peek", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    await expect(plan).toBeVisible();
    await plan.getByRole("button", { name: "Keep this plan" }).click();
    const week = pipHome(page).locator("[data-this-week]");
    await expect(week).toBeVisible();
    // From the workstreams, one stop back is This week.
    await pipHome(page).getByRole("navigation", { name: "Workstreams" }).focus();
    await page.keyboard.press("Shift+F6");
    await expect(week.locator("button:focus")).toHaveCount(1);
    await week.locator("[data-this-week-item] button").first().focus();
    await page.keyboard.press("Enter");
    await expect(peekSheet(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#peek-sheet"))).toBe(true);
  });
});

test.describe("the workstream list is ordered by what needs you (G15)", () => {
  test("a Needs you workstream is listed above an Idle one that is newer, and j and k follow the order shown", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    // CA-401 is the older workstream; CA-402 is newer and has nothing for the person to do.
    await startWorkstream(page, "CA-401");
    await startWorkstream(page, "CA-402");
    await openPipHome(page);
    await homeSettled(page);
    const rows = pipHome(page).getByRole("listbox", { name: "Workstreams" }).getByRole("option");
    await expect(rows.filter({ hasText: /CA-40[12]/ })).toHaveCount(2);
    await expect(workstreamRow(page, "CA-401")).toContainText("Idle");
    // Newest first while neither needs the person.
    await expect(rows).toContainText([/^General/, /^CA-402/, /^CA-401/]);
    // A hold the system made is a need: the older workstream moves above the newer one, General stays first.
    await holdBySystem(page, "CA-401", "restart");
    await expect(workstreamRow(page, "CA-401")).toContainText("Needs you");
    await expect(workstreamRow(page, "CA-402")).toContainText("Idle");
    await expect(rows).toContainText([/^General/, /^CA-401/, /^CA-402/]);
    // j and k go in the order the list shows.
    await workstreamRow(page, "General").focus();
    await page.keyboard.press("j");
    await expect(workstreamRow(page, "CA-401")).toBeFocused();
    await page.keyboard.press("j");
    await expect(workstreamRow(page, "CA-402")).toBeFocused();
    await page.keyboard.press("k");
    await expect(workstreamRow(page, "CA-401")).toBeFocused();
    await page.keyboard.press("k");
    await expect(workstreamRow(page, "General")).toBeFocused();
  });
});
