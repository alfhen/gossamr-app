import { expect, test, type Page } from "@playwright/test";
import { askPip, holdBySystem, homeSettled, needsPane, needsYouCount, needsYouRow, needsYouTray, openApp, openPipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the fifth dogfood round's backlog (G18 to G24): a higher-ranked need waits behind a bar instead of taking the
// decision pane, Pip home lands on the workstream that needs the person, the pane says when it moved on by itself, the
// Agents footer names F6 and Pip home, and the timeline keeps the reader's place.

const MANAGED = "wsManage=1&runs=empty";

/** A managed workstream on CA-401 with a draft comment of Pip's waiting, on Pip home with the draft's decision open. */
async function draftOpen(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  // Alone in its workstream the need is the group's own row.
  await needsYouTray(page).locator("[data-needs-you-group], [data-needs-you-need]").filter({ hasText: /Pip drafted a comment/ }).first().click();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "draft");
}

const higher = (page: Page) => page.locator("[data-needs-higher]");

test("G18: a need that ranks higher and came in later waits behind a bar; the pane stays, and the bar opens it", async ({ page }) => {
  await draftOpen(page);
  // The plan above the draft was there when it opened, so there is no bar.
  await expect(higher(page)).toHaveCount(0);
  await holdBySystem(page, "CA-401", "restart");
  await expect(higher(page)).toHaveText(/^Higher priority:\s*Held after a restart\s*· Open$/);
  // Nothing switched under the person.
  await expect(needsPane(page)).toHaveAttribute("data-kind", "draft");

  await higher(page).focus();
  await page.keyboard.press("Enter");
  await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
  await expect(higher(page)).toHaveCount(0);
});

test("G19: Pip home opens on the workstream of the top need, not on General", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await holdBySystem(page, "CA-401", "restart");
  await openPipHome(page);
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
  await expect(workstreamRow(page, "General")).toHaveAttribute("aria-selected", "false");
});

test("G20: when the pane moves on by itself it says so for a few seconds, and the new pane's card has the keyboard", async ({ page }) => {
  await draftOpen(page);
  await holdBySystem(page, "CA-401", "restart");
  await expect(needsYouRow(page, "CA-401")).toContainText("Held after a restart");
  const pane = needsPane(page);
  await pane.getByRole("button", { name: "Post comment" }).click();
  await expect(pane).toHaveAttribute("data-kind", "hold");
  const line = page.locator("[data-needs-advanced]");
  await expect(line).toHaveText(/^Done: Draft comment on CA-401\. Now: Held after a restart$/);
  await expect(pane).toBeFocused();
  // Not a stop for the keyboard, and it goes by itself.
  await expect(line).toHaveAttribute("role", "status");
  await expect(line).toHaveCount(0, { timeout: 9000 });
  await expect(needsYouCount(page)).toHaveText("1");
});

test("G21: the Agents footer names F6 for the regions and the Pip home key", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  const footer = page.locator("footer").filter({ hasText: "start an agent" });
  await expect(footer).toContainText("j k move");
  await expect(footer).toContainText("F6 regions");
  await expect(footer).toContainText(/⌘0 Pip home/);
});

test("G24: the timeline keeps the entry being read in place when a draft above it is approved", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await draftOpen(page);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 3; i++) {
    await askPip(page, "Draft a comment");
    await homeSettled(page);
  }
  const body = page.locator("[data-timeline]");
  const entries = body.locator("[data-timeline-entry]");
  await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  // At the end it stays at the end.
  await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(25);
  // Scrolled up to an entry, that entry keeps its place as an entry above it changes height (the browser's own anchoring is off here, so it is the timeline's that is tested).
  await body.evaluate((el) => {
    el.style.overflowAnchor = "none";
    el.scrollTop = el.scrollHeight / 2;
  });
  const reading = await body.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const li = Array.from(el.querySelectorAll("[data-timeline-entry]")).find((x) => x.getBoundingClientRect().bottom > top + 40)!;
    return li.getAttribute("data-timeline-entry")!;
  });
  const mine = body.locator(`[data-timeline-entry="${reading}"]`);
  const before = await mine.evaluate((el) => el.getBoundingClientRect().top);
  await entries.first().evaluate((el) => {
    const pad = document.createElement("div");
    pad.style.height = "240px";
    el.prepend(pad);
  });
  await expect.poll(() => mine.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(Math.round(before));
});
