import { expect, test } from "@playwright/test";
import { agentsHome, askPip, commentOnTicket, pauseAtCeiling, homeSettled, jiraWrites, needsPane, openAgents, openApp, pipPane, selectWorkstream, startWorkstream, openNeedRow, needsStack } from "./support/app";

// Fixes from the eighth dogfood round: what the Decide pane's line says was posted, where the pane goes after the last need,
// the left column's heights, the timeline's words for asks.

test.describe("the Decide pane's Done line (G5)", () => {
  test("says a posted comment was posted to Jira, and names the next need's ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await openNeedRow(page, /Pip drafted a comment/);
    await pauseAtCeiling(page, "CA-401");
    await expect(needsStack(page)).toContainText("Paused: Pip was woken too often today");
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Paused: Pip was woken too often today$/);
  });
});

test.describe("the timeline's words for a posted ask (G13)", () => {
  test("a posted reporter ask is 'You posted the questions for the reporter', not a plain comment", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&prSurface=manual&pipPace=1");
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


