import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, closeWorkstreamSheet, homeComposer, homeSettled, jiraWrites, mockRuns, needOfKind, needsPane, needsPaneHeading, openAgents, openApp, paneSettled, pipPane, seedWorkstreamEvent, selectWorkstream, startWorkstream, workstreamGroup, openNeedOfKind } from "./support/app";

// Backlog items of the eleventh dogfood round: dates in the timeline (G22), what the status pill says
// besides the count (G23), one question per bullet (G24), a second line on What Jira saw from me (G25), the composer keeping the
// keyboard after I'll answer (G27), where opening a need lands (G28) and the screens' names and headings (G29).


const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
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
  await openAgents(page);
  await selectWorkstream(page, VAGUE);
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("dates in the timeline and What Jira saw from me (G22)", () => {
  test("an entry from an earlier day sits under its date, and a timeline of today's entries has none", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
    await seedWorkstreamEvent(page, VAGUE, { actor: "person", action: "held", at: yesterday });
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
    await openApp(page, MANAGED);
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

test.describe("an unclear ticket (G23, G24, G25, G27)", () => {
  test("asking the reporter puts one question on each bullet, and the sent page shows a second line under the opener", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await openNeedOfKind(page, "readiness");
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
    await expect(workstreamGroup(page, VAGUE).locator("[data-status-detail]")).toContainText(/waiting on reporter|asked/);

    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const row = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(row.locator("[data-sent-summary]")).toContainText("A few things need clearing up to make this ticket clear to work on");
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
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await page.keyboard.type("Done means the winback mail goes out.");
    await expect(homeComposer(page)).toHaveValue(/My answers: Done means the winback mail goes out\.$/);
    // Whatever the pane did, the keyboard stayed in the composer.
    await expect(homeComposer(page)).toBeFocused();
    await expect(workstreamGroup(page, VAGUE).locator("[data-status-detail]")).toContainText("your answers owed");
  });
});

test.describe("opening a need (G28)", () => {
  test("always lands on the pane's heading, whatever the kind of need", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    for (const kind of ["readiness", "draft"]) {
      await openNeedOfKind(page, kind);
      await expect(needsPane(page)).toBeVisible();
      await expect(needsPaneHeading(page)).toBeFocused();
      await expect(needsPaneHeading(page)).toHaveAttribute("role", "heading");
      await page.keyboard.press("Escape");
      await expect(needsPane(page)).toHaveCount(0);
    }
  });
});

