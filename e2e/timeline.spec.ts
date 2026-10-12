import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPermission,
  askPip,
  finishOnHome,
  homeConversation,
  homeConversationRegion,
  homeRunCards,
  homeSettled,
  inlineStart,
  mockRuns,
  needsPane,
  openApp,
  openPipHome,
  pipHome,
  PIP_INPUT,
  startWorkstream,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

// New workstreams open in Manage, so the sample supervisor starts the routine next steps; pull requests show only when a test says.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const timeline = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");
const entries = (page: Page) => timeline(page).locator("[data-timeline-entry]");
const filterBar = (page: Page) => page.getByRole("group", { name: "Timeline filter" });
const filter = (page: Page, name: string) => filterBar(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Waits for a rule to have started the next run of `kind`, and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** Each entry's key and kind, top to bottom. */
const shown = (page: Page) => entries(page).evaluateAll((els) => els.map((e) => ({ key: e.getAttribute("data-timeline-entry")!, kind: e.getAttribute("data-kind")! })));

/**
 * A managed workstream on CA-401 opened on Pip home, its investigation asked of Pip and started in place: the chain's
 * first run. Returns the investigation.
 */
async function investigating(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await askPip(page, "investigate this");
  await homeSettled(page);
  const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await review.getByRole("button", { name: "Start agent" }).click();
  await expect(review).toHaveCount(0);
  return (await started(page, "investigate"))!;
}

/** The chain on: the investigation finishes, the rule's triage finishes, and the person holds the workstream. */
async function chain(page: Page) {
  const r1 = await investigating(page);
  await finishOnHome(page, r1.id);
  const r2 = await started(page, "triage");
  await finishOnHome(page, r2.id);
  // The triage's rule queues the plan.
  const r3 = await started(page, "plan");
  await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
  await expect.poll(async () => (await workstreamEvents(page)).some((e) => e.action === "held")).toBe(true);
  return { r1, r2, r3 };
}

test("a chain's conversation, runs, drafts and audit lines read as one timeline, oldest first, one row per run", async ({ page }) => {
  const { r1, r2 } = await chain(page);
  const held = timeline(page).locator('[data-kind="audit"]', { hasText: "You held the workstream" });
  await expect(held).toHaveCount(1);
  const heldKey = (await held.getAttribute("data-timeline-entry"))!;
  const ws = (await workstreamEvents(page)).find((e) => e.action === "held")!.workstreamId;
  expect(heldKey).toMatch(new RegExp(`^audit:${ws}:\\d+$`));

  const list = await shown(page);
  const at = (key: string) => list.findIndex((e) => e.key === key);
  // One row for each run, however far it got, saying how it ended.
  expect(list.filter((e) => e.key === `run:${r1.id}`)).toHaveLength(1);
  expect(list.filter((e) => e.key === `run:${r2.id}`)).toHaveLength(1);
  await expect(timeline(page).locator(`[data-timeline-entry="run:${r1.id}"]`)).toHaveAttribute("data-phase", "finished");
  await expect(timeline(page).locator(`[data-timeline-entry="run:${r1.id}"] [data-timeline-line]`)).toContainText(/Investigate R1 finished/);
  await expect(timeline(page).locator(`[data-timeline-entry="run:${r2.id}"] [data-timeline-line]`)).toContainText(/Triage R2 finished/);
  // In order: the person's question, its run draft, the investigation, Pip's wake about it, the triage, the triage's drafts, the hold.
  const asked = list.findIndex((e) => e.kind === "said");
  const runDraft = list.findIndex((e) => e.kind === "draft");
  const wakes = list.map((e, i) => (e.kind === "pip" ? i : -1)).filter((i) => i >= 0);
  // Only the audit's "You opened the workstream" comes before the first question.
  expect(asked).toBeGreaterThanOrEqual(0);
  expect(list.slice(0, asked).every((e) => e.kind === "audit")).toBe(true);
  expect(runDraft).toBeGreaterThan(asked);
  expect(at(`run:${r1.id}`)).toBeGreaterThan(runDraft);
  expect(wakes.length).toBeGreaterThanOrEqual(2);
  expect(wakes[0]).toBeGreaterThan(at(`run:${r1.id}`));
  expect(at(`run:${r2.id}`)).toBeGreaterThan(at(`run:${r1.id}`));
  const triageDrafts = list.map((e, i) => (e.kind === "draft" && i > at(`run:${r2.id}`) ? i : -1)).filter((i) => i >= 0);
  expect(triageDrafts.length).toBeGreaterThan(0);
  expect(at(heldKey)).toBe(list.length - 1);
  // Draft cards sit on the timeline itself, keys and all: the run draft, decided by its start, says so.
  await expect(timeline(page).locator("[data-timeline-entry]").nth(runDraft)).toContainText(/Start an agent|started/);
  // The step rail and the composer are still there beside it.
  await expect(pipHome(page).getByRole("complementary", { name: "Steps" })).toBeVisible();
  await expect(page.locator(PIP_INPUT)).toBeVisible();
});

test("the filters show the runs, the drafts or the decisions alone, and All brings everything back", async ({ page }) => {
  const { r1, r2, r3 } = await chain(page);
  const all = await entries(page).count();
  await expect(filter(page, "All")).toHaveAttribute("aria-pressed", "true");

  await filter(page, "Runs").click();
  await expect(filter(page, "Runs")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await shown(page)).map((e) => e.key)).toEqual([`run:${r1.id}`, `run:${r2.id}`, `run:${r3.id}`]);

  await filter(page, "Drafts").click();
  const drafts = await shown(page);
  expect(drafts.length).toBeGreaterThan(1);
  expect(drafts.every((e) => e.kind === "draft")).toBe(true);

  await filter(page, "Decisions").click();
  const decisions = await shown(page);
  expect(decisions.some((e) => e.kind === "audit")).toBe(true);
  expect(decisions.some((e) => e.kind === "said" || e.kind === "pip")).toBe(false);
  await expect(timeline(page)).toContainText("You held the workstream");

  await filter(page, "All").click();
  await expect(entries(page)).toHaveCount(all);
});

test("Agents is the Runs filter across every workstream, with the same rows, and its other filters go back to the timeline", async ({ page }) => {
  const r1 = await investigating(page);
  await filter(page, "Runs").click();
  await homeConversationRegion(page).getByRole("button", { name: "Runs in every workstream (Agents)" }).click();
  // The Agents screen, with Runs pressed, lists the run on the same row the timeline shows it with.
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(filterBar(page).getByRole("button", { name: "Runs" })).toHaveAttribute("aria-pressed", "true");
  await expect(main.locator("[data-agents-scope]")).toHaveText("in every workstream");
  await main.getByRole("button", { name: "List", exact: true }).click();
  await expect(main.locator(`article#agent-${r1.id}[data-run-id="${r1.id}"]`)).toBeVisible();
  // The rail's Agents button lands here too.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(filterBar(page).getByRole("button", { name: "Runs" })).toHaveAttribute("aria-pressed", "true");

  await filterBar(page).getByRole("button", { name: "Drafts" }).click();
  await expect(pipHome(page)).toBeVisible();
  await expect(filter(page, "Drafts")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await shown(page)).every((e) => e.kind === "draft")).toBe(true);
  // The timeline's run row is the Agents row.
  await filter(page, "Runs").click();
  await expect(timeline(page).locator(`article#agent-${r1.id}[data-run-id="${r1.id}"]`)).toBeVisible();
});

test("a run waiting on you is a timeline entry that opens its need in Needs you, from the keyboard and the pointer", async ({ page }) => {
  const r1 = await investigating(page);
  for (let i = 0; i < 2; i++) await advanceRuns(page, 1, r1.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r1.id)?.state).toBe("working");
  await homeSettled(page);
  await askPermission(page, r1.id, "approve Bash: git push origin ca-401");
  const entry = timeline(page).locator(`[data-timeline-entry="run:${r1.id}"]`);
  await expect(entry).toHaveAttribute("data-phase", "waiting");
  await expect(entry).toHaveAttribute("data-waiting", `run:${r1.id}`);
  await expect(entry.locator("[data-timeline-line]")).toContainText("is waiting on you");

  // j and k walk the entries; o opens the one with the keyboard.
  const row = entry.locator(`article[data-run-id="${r1.id}"]`);
  await row.focus();
  await page.keyboard.press("k");
  await expect(row).not.toBeFocused();
  await page.keyboard.press("j");
  await expect(row).toBeFocused();
  await expect(pipHome(page).locator("[data-pip-home-hints]")).toContainText("move through the timeline");
  await page.keyboard.press("o");
  await expect(needsPane(page)).toBeVisible();
  await expect(needsPane(page)).toContainText("git push");
  // The decision itself: a read-only investigation can't be allowed, so Deny lets it carry on.
  await expect(needsPane(page).getByRole("button", { name: "Deny" })).toBeVisible();

  // Closed, the line's own "In Needs you" opens the same need.
  await needsPane(page).getByRole("button", { name: "Back to the list" }).click();
  await expect(needsPane(page)).toHaveCount(0);
  await entry.locator("[data-timeline-need]").click();
  await expect(needsPane(page)).toContainText("git push");
});
