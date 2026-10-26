import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, editTicket, jiraWrites, mockRuns, openApp, pausedBanner, peekSheet, pipConversation, paneSettled as settled, pipPane, startWorkstream, surfacePullRequests, wakeTurns, wakes, workstreamEvents } from "./support/app";

// The sample supervisor wakes Pip once for each finished run of a workstream that isn't paused, and starts nothing itself.
// Pull requests show only when a test says. `pipPace=1` makes the sample Pip answer at once: nothing here is about how fast
// an answer streams, and at its usual pace the answers a finish and a question queue up take longer than the 5 seconds a
// wait has on a machine that is busy.
const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });

/** Asks Pip for an investigation of `key`, opens its draft and starts it, as the person does. */
async function startInvestigation(page: Page, key = "CA-401") {
  // The wake the last finish queued is answered first: asked while it runs, the question sets it aside and it is answered
  // again behind the question, two turns instead of one.
  await settled(page);
  await askPip(page, "investigate this");
  await settled(page);
  await runCards(page, key).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** The newest run of `kind`, as the sample backend holds it. */
async function newest(page: Page, kind: string) {
  return (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
}

/**
 * Moves run `id` on to done: queued, launching, working, done. Only that run moves. It waits for Pip to finish
 * answering first, so each finish gets a wake turn of its own rather than merging into one still waiting.
 */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);

test("a finished investigation wakes Pip once and starts nothing; asked again, nothing doubles", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await expect(wakes(page)).toHaveCount(0);

  await finish(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  await settled(page);
  expect((await mockRuns(page)).filter((r) => r.kind !== "investigate")).toEqual([]);
  expect((await actions(page, "autostart")).length).toBe(0);

  // The same finish again, and a look over everything, wake nobody.
  await advanceRuns(page, 1, r1.id);
  await surfacePullRequests(page);
  await settled(page);
  await expect(wakes(page)).toHaveCount(1);
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);

  // Pip's own turns start and stop nothing.
  const before = await mockRuns(page);
  await askPip(page, "start the build");
  await settled(page);
  await askPip(page, "stop R1");
  await settled(page);
  expect(await mockRuns(page)).toEqual(before);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a paused workstream wakes nobody; Resume wakes Pip once for what finished meanwhile", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await settled(page);

  await pipPane(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(pausedBanner(page)).toContainText("Paused. Pip isn't woken until you resume it.");
  await finish(page, r1.id);
  await advanceRuns(page, 3);
  await settled(page);
  expect(await wakeTurns(page)).toBe(0);
  expect(await actions(page, "wake")).toEqual([]);
  expect((await mockRuns(page)).filter((r) => r.kind !== "investigate")).toEqual([]);

  await pausedBanner(page).getByRole("button", { name: "Resume" }).click();
  await expect(pausedBanner(page)).toHaveCount(0);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);
  expect((await actions(page, "paused")).map((e) => e.actor)).toEqual(["person"]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a ticket edited in Jira is noted in the timeline once, holds nothing up, and still wakes Pip", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await settled(page);

  await editTicket(page, "CA-401", { description: "Rounding is off by a cent in the cart total, and in the invoice." });
  await expect.poll(async () => (await actions(page, "basis_drifted")).map((e) => e.detail)).toEqual(["description"]);
  await expect(pipPane(page).locator("[data-timeline-line]").filter({ hasText: "The ticket's description changed in Jira" })).toHaveCount(1);
  await expect(pausedBanner(page)).toHaveCount(0);

  await finish(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  expect((await actions(page, "basis_drifted")).length).toBe(1);
});

test("Esc closes only the menu or confirmation that is open: the pane, the peek and the workstream's conversation stay", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  const more = pipPane(page).getByRole("button", { name: "More for this workstream" });
  const stays = async () => {
    await expect(pipPane(page)).toHaveCount(1);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  };

  // With the ticket's peek open.
  await more.click();
  const stop = pipPane(page).getByRole("menuitem", { name: "Stop the workstream…" });
  await expect(stop).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await stays();
  await expect(more).toBeFocused();

  // The Stop confirmation closes on Esc too, and hands focus back to the menu's button.
  await more.click();
  await stop.click();
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toHaveCount(0);
  await stays();
  await expect(more).toBeFocused();

  // With no peek, where Esc would otherwise close the pane.
  await startInvestigation(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(peekSheet(page)).toHaveCount(0);
  await stays();
  await more.click();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("menuitem", { name: "Stop the workstream…" })).toHaveCount(0);
  await stays();
  await expect(more).toBeFocused();
});
