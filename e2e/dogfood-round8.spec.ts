import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, commentOnTicket, holdBySystem, homeSettled, jiraWrites, mockRuns, needsPane, openAgents, openApp, paneSettled as settled, peekSheet, peekTicket, pipPane, selectWorkstream, startWorkstream, openNeedRow, needsStack } from "./support/app";

// Fixes from the eighth dogfood round: what the Decide pane's line says was posted, where the pane goes after the last need,
// the left column's heights, the timeline's words for asks and rule-started runs, and the plan draft's Build.

test.describe("the Decide pane's Done line (G5)", () => {
  test("says a posted comment was posted to Jira, and names the next need's ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await openNeedRow(page, /Pip drafted a comment/);
    await holdBySystem(page, "CA-401", "restart");
    await expect(needsStack(page)).toContainText("Held after a restart");
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Held after a restart$/);
  });
});

const SUPERVISED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });

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
    await pipPane(page).getByRole("article", { name: "Start an agent: CA-401" }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page)).toBeVisible();
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
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(pipPane(page).locator("[data-timeline-line]").filter({ hasText: "Gossamr started the build run automatically on CA-401 after you approved the plan" })).toHaveCount(1);
  });
});

test.describe("the timeline's words for a posted ask (G13)", () => {
  test("a posted reporter ask is 'You posted the questions for the reporter', not a plain comment", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&prSurface=manual&wsManage=1&pipPace=1");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await expect(pipPane(page).locator("[data-timeline-line]").filter({ hasText: "You posted the questions for the reporter on CA-408" })).toHaveCount(1);
  });
});

test.describe("the reporter's reply stays in the timeline (G1, G12, G13)", () => {
  test("a reply that ended the wait is still there once the person asks again, and a reply of two lines is quoted on both (G27 of round 12)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const notice = agentsHome(page).locator("[data-clarity-notice]");
    const askAndPost = async (posted: number) => {
      await notice.getByRole("button", { name: "Ask the reporter now" }).click();
      await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
      await expect.poll(async () => (await jiraWrites(page)).filter((w) => w.type === "comment").length).toBe(posted);
    };
    await askAndPost(1);
    await commentOnTicket(page, "CA-408", "It should send three emails.\nOne to the shopper, two to support.");
    const lines = pipPane(page).locator("[data-timeline] [data-timeline-line]");
    const reply = lines.filter({ hasText: "The reporter replied on the ticket" });
    await expect(reply.locator("[data-timeline-detail]")).toHaveText("“It should send three emails. One to the shopper, two to support.”");
    await askAndPost(2);
    // Asking again ended the wait the reply ended, but the reply stays, between the two asks.
    await expect(reply).toHaveCount(1);
    await expect(lines.filter({ hasText: "You posted the questions for the reporter on CA-408" })).toHaveCount(1);
    await expect(lines.filter({ hasText: "You posted the follow-up questions for the reporter on CA-408" })).toHaveCount(1);
  });
});


