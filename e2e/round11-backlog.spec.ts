import { expect, test } from "@playwright/test";
import { askPip, closeWorkstreamSheet, homeSettled, needsPane, needsPaneHeading, openAgents, openApp, pauseAtCeiling, pipPane, seedWorkstreamEvent, selectWorkstream, startWorkstream, openNeedOfKind } from "./support/app";

// Backlog items of the eleventh dogfood round: dates in the timeline (G22), where opening a need lands (G28) and the screens'
// names and headings (G29).

const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";
const VAGUE = "CA-408";

test.describe("dates in the timeline (G22)", () => {
  test("an entry from an earlier day sits under its date, and a timeline of today's entries has none", async ({ page }) => {
    await openApp(page, SAMPLE);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "paused", at: yesterday });
    await closeWorkstreamSheet(page);
    await selectWorkstream(page, VAGUE);
    const heads = timeline.locator("[data-timeline-day]");
    await expect(heads.first()).toBeVisible();
    await expect(heads.first()).toHaveText(/^(Yesterday|Today|[A-Z][a-z]+day)$/);
    // The first entry of today has its own header once an earlier day is listed.
    await expect(heads.last()).toHaveText("Today");
    // Walking the entries with j and k does not stop on a header.
    expect(await timeline.locator("[data-timeline-day][tabindex]").count()).toBe(0);
  });

  test("a timeline left open over local midnight puts today's entries under Yesterday, though no entry changed", async ({ page }) => {
    const now = new Date();
    await page.clock.install({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 57) });
    await openApp(page, SAMPLE);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const entries = await timeline.locator("[data-timeline-entry]").count();
    await page.clock.runFor(5 * 60_000);
    await expect(timeline.locator("[data-timeline-day]").first()).toHaveText("Yesterday");
    expect(await timeline.locator("[data-timeline-entry]").count()).toBe(entries);
  });
});

test.describe("opening a need (G28)", () => {
  test("always lands on the pane's heading, whatever the kind of need", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, SAMPLE);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await pauseAtCeiling(page, VAGUE);
    for (const kind of ["paused", "draft"]) {
      await openNeedOfKind(page, kind);
      await expect(needsPane(page)).toBeVisible();
      await expect(needsPaneHeading(page)).toBeFocused();
      await expect(needsPaneHeading(page)).toHaveAttribute("role", "heading");
      await page.keyboard.press("Escape");
      await expect(needsPane(page)).toHaveCount(0);
    }
  });
});
