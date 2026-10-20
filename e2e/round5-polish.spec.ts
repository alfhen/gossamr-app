import { expect, test, type Page } from "@playwright/test";
import { askPip, holdBySystem, homeSettled, needsPane, needsPaneHeading, needsYouCount, openAgents, openApp, selectWorkstream, startWorkstream, openNeedRow, needsStack } from "./support/app";

// Fixes from the fifth dogfood round's backlog (G18 to G24): a higher-ranked need waits behind a bar instead of taking the
// decision pane, Pip home lands on the workstream that needs the person, the pane says when it moved on by itself, the
// Agents footer names F6 and Pip home, and the timeline keeps the reader's place.

const MANAGED = "wsManage=1&runs=empty";

/** A managed workstream on CA-401 with a draft comment of Pip's waiting, on Pip home with the draft's decision open. */
async function draftOpen(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  // Alone in its workstream the need is the group's own row.
  await openNeedRow(page, /Pip drafted a comment/);
  await expect(needsPane(page)).toHaveAttribute("data-kind", "draft");
}

test("G18: a need that ranks higher and comes in later is listed above the open one, and nothing switches under the person", async ({ page }) => {
  await draftOpen(page);
  await holdBySystem(page, "CA-401", "restart");
  const kinds = needsStack(page).locator("[data-needs-pane]");
  await expect.poll(async () => (await kinds.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).filter((k) => k === "hold" || k === "draft")).toEqual(["hold", "draft"]);
  // The decision that was open stays open.
  await expect(needsPane(page)).toHaveAttribute("data-kind", "draft");
});

test("G20: when the pane moves on by itself it says so for a few seconds, and the new pane's heading has the keyboard", async ({ page }) => {
  await draftOpen(page);
  await holdBySystem(page, "CA-401", "restart");
  await expect(needsStack(page)).toContainText("Held after a restart");
  const pane = needsPane(page);
  await pane.getByRole("button", { name: "Post comment" }).click();
  await expect(pane).toHaveAttribute("data-kind", "hold");
  const line = page.locator("[data-needs-advanced]");
  await expect(line).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Held after a restart$/);
  await expect(needsPaneHeading(page)).toBeFocused();
  // Not a stop for the keyboard, and it goes by itself.
  await expect(line).toHaveAttribute("role", "status");
  await expect(line).toHaveCount(0, { timeout: 9000 });
  await expect(needsYouCount(page)).toHaveText("1");
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
