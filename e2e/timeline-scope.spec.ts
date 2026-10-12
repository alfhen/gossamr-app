import { expect, test, type Page } from "@playwright/test";
import { askPip, homeConversationRegion, homeSettled, openApp, openPipHome, PIP_INPUT, pipHome, pipIdle, pipPane, startWorkstream, workstreamRow } from "./support/app";

// The cross-workstream scope, the timeline in the Pip pane, and the palette's timeline commands (docs/needs-you.md, step 3).
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const timeline = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");
const entries = (page: Page) => timeline(page).locator("[data-timeline-entry]");
const filterBar = (page: Page) => page.getByRole("group", { name: "Timeline filter" });
const filter = (page: Page, name: string) => filterBar(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
const scope = (page: Page, name: string) => page.getByRole("group", { name: "Timeline scope" }).getByRole("button", { name });
const labelsShown = (page: Page) => entries(page).evaluateAll((els) => els.map((e) => e.querySelector("[data-timeline-workstream]")?.textContent ?? null));

/** Runs the palette entry named exactly `label`. */
async function palette(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.type(label);
  await expect(dialog.getByRole("option").first()).toContainText(label);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
}

/** Workstreams on CA-402 then CA-401, and a question in General, on Pip home with CA-401 selected. */
async function twoWorkstreams(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-402");
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "General").click();
  await askPip(page, "what is on screen");
  await homeSettled(page);
  await workstreamRow(page, "CA-401").click();
  await expect(scope(page, "This workstream")).toHaveAttribute("aria-pressed", "true");
}

test("Every workstream merges each open workstream's timeline and General's by time, each entry labelled; Runs there is Agents", async ({ page }) => {
  await twoWorkstreams(page);
  // This workstream: CA-401's own entries, unlabelled.
  const own = await entries(page).count();
  expect(own).toBeGreaterThan(0);
  expect((await labelsShown(page)).every((l) => l === null)).toBe(true);

  await scope(page, "Every workstream").click();
  await expect(scope(page, "Every workstream")).toHaveAttribute("aria-pressed", "true");
  await expect(timeline(page).locator('[data-timeline-workstream="general"]').first()).toBeVisible();
  const labels = await labelsShown(page);
  // Every entry carries its workstream; CA-402 was opened first, so its first line comes before CA-401's.
  expect(labels.every((l) => l !== null)).toBe(true);
  expect(new Set(labels)).toEqual(new Set(["CA-402", "CA-401", "General"]));
  expect(labels.indexOf("CA-402")).toBeLessThan(labels.indexOf("CA-401"));
  expect(labels.length).toBeGreaterThan(own);
  // Oldest first across workstreams.
  const times = await entries(page).evaluateAll((els) => els.map((e) => e.querySelector("time")?.getAttribute("datetime") ?? null).filter((t): t is string => !!t));
  expect(times.length).toBeGreaterThan(1);
  expect([...times].sort((a, b) => Date.parse(a) - Date.parse(b))).toEqual(times);
  // The question asked in General is there, labelled General.
  await expect(timeline(page).locator('[data-timeline-entry][data-kind="said"]', { hasText: "what is on screen" }).locator('[data-timeline-workstream="general"]')).toHaveCount(1);

  // Decisions in every workstream: the filter applies across them too.
  await filter(page, "Decisions").click();
  await expect(filter(page, "Decisions")).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page, "Every workstream")).toHaveAttribute("aria-pressed", "true");
  expect((await labelsShown(page)).every((l) => l !== null)).toBe(true);

  // Runs in every workstream is the Agents screen, with Every workstream pressed there.
  await filter(page, "Runs").click();
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(filter(page, "Runs")).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page, "Every workstream")).toHaveAttribute("aria-pressed", "true");
  // This workstream from there: CA-401's runs on Pip home.
  await scope(page, "This workstream").click();
  await expect(pipHome(page)).toBeVisible();
  await expect(filter(page, "Runs")).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page, "This workstream")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await entries(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).every((k) => k === "run")).toBe(true);
});

test("the Pip pane shows the workstream's timeline over its composer, with a filter of its own", async ({ page }) => {
  await openApp(page, MANAGED);
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
  // go back to the input, as on Pip home).
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
  // Pip home's filter is its own, left as it was.
  await paneFilter.getByRole("button", { name: /^Decisions\b/ }).click();
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(filter(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(timeline(page).locator('[data-timeline-entry][data-kind="said"]', { hasText: "investigate this" })).toHaveCount(1);
});

test("⌘K switches the timeline's filter and scope, and Runs in every workstream goes to Agents", async ({ page }) => {
  await twoWorkstreams(page);
  await palette(page, "Timeline: Decisions");
  await expect(filter(page, "Decisions")).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page, "This workstream")).toHaveAttribute("aria-pressed", "true");

  await palette(page, "Timeline: Every workstream");
  await expect(scope(page, "Every workstream")).toHaveAttribute("aria-pressed", "true");
  await expect(filter(page, "Decisions")).toHaveAttribute("aria-pressed", "true");

  await palette(page, "Timeline: Runs");
  await expect(page.locator("main").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await palette(page, "Timeline: This workstream");
  await expect(pipHome(page)).toBeVisible();
  await expect(filter(page, "Runs")).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page, "This workstream")).toHaveAttribute("aria-pressed", "true");

  await palette(page, "Timeline: All");
  await expect(filter(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(entries(page).first()).toBeVisible();
});
