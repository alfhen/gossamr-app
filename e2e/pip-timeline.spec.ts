import { expect, test } from "@playwright/test";
import { askPip, openApp, PIP_INPUT, pipIdle, pipPane, startWorkstream } from "./support/app";

// The timeline in the Pip pane (docs/needs-you.md).
const SAMPLE = "runs=empty&prSurface=manual";

test("the Pip pane shows the workstream's timeline over its composer, with a filter of its own", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  const pane = pipPane(page);
  const paneTimeline = pane.locator("[data-timeline]");
  await expect(paneTimeline).toBeVisible();
  // The workstream's opening line is its first entry; no old run strip or Drafts waiting list.
  await expect(paneTimeline.locator('[data-timeline-entry][data-kind="audit"]').first()).toBeVisible();
  await expect(pane.getByRole("region", { name: "Your agents" })).toHaveCount(0);
  await expect(pane.getByRole("region", { name: "Drafts" })).toHaveCount(0);

  await askPip(page, "investigate this");
  await expect.poll(() => pipIdle(page)).toBe(true);
  const asked = paneTimeline.locator('[data-timeline-entry][data-kind="said"]', { hasText: "investigate this" });
  await expect(asked).toHaveCount(1);
  const runDraft = paneTimeline.locator('[data-timeline-entry][data-kind="draft"] article[data-draft]').last();
  await expect(runDraft).toBeVisible();
  // The composer and its Commands button are still the pane's.
  await expect(pane.locator(PIP_INPUT)).toBeVisible();
  await expect(pane.getByRole("button", { name: "Commands" })).toBeVisible();

  // ArrowUp from the empty composer reaches the newest draft, and again walks back up the timeline (a letter there would
  // go back to the input).
  await pane.locator(PIP_INPUT).press("ArrowUp");
  await expect(runDraft).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(runDraft).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Pip"] [data-timeline-entry]'))).toBe(true);

  // The pane's own filter: Drafts shows its drafts alone.
  const paneFilter = pane.getByRole("group", { name: "Filter", exact: true });
  await paneFilter.getByRole("button", { name: /^Drafts\b/ }).click();
  await expect(paneFilter.getByRole("button", { name: /^Drafts\b/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await paneTimeline.locator("[data-timeline-entry]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).every((k) => k === "draft")).toBe(true);
  await expect(paneTimeline.locator("[data-timeline-entry]").first()).toBeVisible();
  await paneFilter.getByRole("button", { name: /^All\b/ }).click();
  await expect(asked).toHaveCount(1);
});
