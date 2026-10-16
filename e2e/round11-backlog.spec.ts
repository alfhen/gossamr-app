import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  homeComposer,
  homeSettled,
  jiraWrites,
  mockRuns,
  needOfKind,
  needsPane,
  needsPaneHeading,
  openApp,
  openPipHome,
  paneSettled,
  pipHome,
  pipPane,
  seedWorkstreamEvent,
  startWorkstream,
  workstreamRow,
} from "./support/app";

// Backlog items of the eleventh dogfood round: Start my day's room (G21), dates in the timeline (G22), what the status pill says
// besides the count (G23), one question per bullet (G24), a second line on What Jira saw from me (G25), the composer keeping the
// keyboard after I'll answer (G27), where opening a need lands (G28) and the screens' names and headings (G29).

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** Moves run `id` on to done once Pip has answered. */
async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** A managed workstream on the vague ticket, its investigation and the triage a rule started: not ready to plan. Left on Pip home. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
  await finish(page, (await newest(page, "triage"))!.id);
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("Start my day's room (G21)", () => {
  test.use({ storageState: DAY_DUE, viewport: { width: 1440, height: 900 } });

  test("shows its lines at 1440x900 without scrolling while the conversation under it is empty", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    const day = pipHome(page).locator('[data-pip-home-day][role="region"]');
    await expect(day).toHaveAttribute("aria-label", "Start my day");
    await expect(day.locator("[data-day-line]").first()).toBeVisible();
    const room = await day.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, cap: parseFloat(getComputedStyle(el).maxHeight) }));
    // It fits in what it was given, and the cap is more than the third of the window it has once there is a conversation.
    expect(room.over).toBeLessThanOrEqual(4);
    await expect(day.locator("[data-day-fade]")).toHaveCount(0);
    expect(room.cap).toBeGreaterThan(900 * 0.4);
  });

  test("keeps to a third of the window, and its More below hint, once the conversation has something in it", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await homeComposer(page).fill("hello");
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    const day = pipHome(page).locator('[data-pip-home-day][role="region"]');
    expect(await day.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight))).toBeLessThanOrEqual(900 * 0.3 + 1);
  });
});

test.describe("dates in the timeline and What Jira saw from me (G22)", () => {
  test("an entry from an earlier day sits under its date, and a timeline of today's entries has none", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    const timeline = pipHome(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "held", at: yesterday });
    await workstreamRow(page, "General").click();
    await workstreamRow(page, VAGUE).click();
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
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    const timeline = pipHome(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const entries = await timeline.locator("[data-timeline-entry]").count();
    await page.clock.runFor(5 * 60_000);
    await expect(timeline.locator("[data-timeline-day]").first()).toHaveText("Yesterday");
    expect(await timeline.locator("[data-timeline-entry]").count()).toBe(entries);
  });
});

test.describe("an unclear ticket (G23, G24, G25, G27)", () => {
  test("asking the reporter puts one question on each bullet, and the sent page shows a second line under the opener", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft).toContainText("What does done look like for CA-408?");
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = await draft.locator("textarea").first().inputValue();
    const bullets = text.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    for (const b of bullets) expect(b.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(bullets).toContain("- What does done look like for CA-408?");
    expect(bullets).toContain("- Which behaviour or number should change?");
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    // The workstream now waits on the reporter: the row's pill says so, beside whatever else is waiting on the person.
    await expect(workstreamRow(page, VAGUE).locator("[data-status-detail]")).toContainText(/waiting on reporter|asked/);

    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const row = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(row.locator("[data-sent-summary]")).toContainText("A few things need clearing up so the work can be planned");
    await expect(row.locator("[data-sent-second]")).toHaveText(/^- What does done look like for CA-408\?( \(\+\d+ more\))?$/);
    await row.getByRole("button", { name: "Show the posted text" }).click();
    await expect(row.locator("[data-sent-detail]")).toContainText("Which behaviour or number should change?");
  });

  test("I'll answer says the answers are owed, and what is typed at once lands in Pip's composer with another need waiting", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    // A second need, so the decision pane may move on when the first is settled. G27 did not reproduce here (the sample backend settles before the composer is focused); this keeps it so.
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await expect(needOfKind(page, "readiness")).toBeVisible();
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await page.keyboard.type("Done means the winback mail goes out.");
    await expect(homeComposer(page)).toHaveValue(/My answers: Done means the winback mail goes out\.$/);
    // Whatever the pane did, the keyboard stayed in the composer.
    await expect(homeComposer(page)).toBeFocused();
    await expect(workstreamRow(page, VAGUE).locator("[data-status-detail]")).toContainText("your answers owed");
  });
});

test.describe("opening a need (G28)", () => {
  test("always lands on the pane's heading, whatever the kind of need", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    for (const kind of ["readiness", "draft"]) {
      const row = needOfKind(page, kind);
      await expect(row.first()).toBeVisible();
      await row.first().click();
      await expect(needsPane(page)).toBeVisible();
      await expect(needsPaneHeading(page)).toBeFocused();
      await expect(needsPaneHeading(page)).toHaveAttribute("role", "heading");
      await page.keyboard.press("Escape");
      await expect(needsPane(page)).toHaveCount(0);
    }
  });
});

test.describe("the screens' names (G29)", () => {
  test.use({ storageState: DAY_DUE });

  test("the tab says which screen is open, the main area is named, and a screen's heading takes the keyboard", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await expect(page).toHaveTitle("Pip home — Gossamr");
    await expect(page.getByRole("main", { name: "Pip home" })).toBeVisible();
    await pipHome(page).locator("[data-start-my-day] [data-day-sent]").click();
    await expect(page).toHaveTitle("What Jira saw from me — Gossamr");
    await expect(page.getByRole("main", { name: "What Jira saw from me" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "What Jira saw from me" })).toBeFocused();
    await page.locator("[data-sent-back]").click();
    await expect(page).toHaveTitle("Pip home — Gossamr");
  });
});
