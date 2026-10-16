import { expect, test, type Page } from "@playwright/test";
import {
  askPermission,
  askPip,
  editTicket,
  expandAllNeeds,
  homeConversation,
  homeRunCards,
  homeSettled,
  jiraWrites,
  mockRuns,
  needOfKind,
  needsPane,
  needsYouTray,
  openApp,
  openPipHome,
  pipHome,
  startWorkstream,
  workstreamEvents,
  workstreamRow,
  advanceRuns,
  homeConversationRegion,
  expectToast,
} from "./support/app";

// Backlog items of the thirteenth dogfood round: a workstream's offer to bring in what its ticket already has in General (G17),
// Close with an Undo and a Reopen (G23), the safety copy saying a Build and the glossary's Manage, Hold and Allow once (G24), what
// the reporter question says about posting (G25), the posting pause's two buttons (G26), Tab in the first-run safety sheet and in
// the start review (G27), names a screen reader hears once (G28), the posted entry's footer (G29), the Done ticket's one reason
// (G30) and 'start' in the palette (G31).

const port = Number(process.env.E2E_PORT ?? 4173);
/** A first run: nothing set aside, so the orientation card shows. */
const FIRST_RUN = { cookies: [], origins: [] };
/** The seeded profile without Start my day set aside, so its card (and Plan my week) show. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const THIN = "Fix it.";
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";
const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const notice = (page: Page) => pipHome(page).locator("[data-clarity-notice]");
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

/** A workstream on `key`, begun from its peek. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

/** The reporter question draft on a vague ticket: a workstream on it, "Ask the reporter now" pressed, its card in the decision pane. */
async function reporterDraft(page: Page) {
  await openApp(page, "runs=empty");
  await editTicket(page, "CA-408", { description: THIN });
  await begin(page, "CA-408");
  await openPipHome(page);
  await workstreamRow(page, "CA-408").click();
  await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
  const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("a workstream opened on a ticket with runs in General (G17)", () => {
  test("offers them in one line, moves them only on the button, audits it, and Undo puts them back", async ({ page }) => {
    test.setTimeout(120_000);
    // The sample's running investigation of WEB-108 was started from the board, so it sits under General.
    await openApp(page);
    await begin(page, "WEB-108");
    await openPipHome(page);
    await workstreamRow(page, "WEB-108").click();
    await homeSettled(page);
    const offer = pipHome(page).locator("[data-adopt-notice]");
    await expect(offer).toContainText("1 run on WEB-108 is under General.");
    const runs = homeConversationRegion(page).locator('[data-timeline-entry^="run:"]');
    // Opening moved nothing: the workstream's timeline has no run, and the audit has no adoption.
    await expect(runs).toHaveCount(0);
    expect((await workstreamEvents(page)).some((e) => e.action === "adopted")).toBe(false);

    await offer.getByRole("button", { name: "Bring them here" }).click();
    await expectToast(page, "Brought 1 run on WEB-108 into the workstream.");
    await expect(offer).toHaveCount(0);
    await expect(runs).toHaveCount(1);
    expect((await workstreamEvents(page)).filter((e) => e.action === "adopted")).toMatchObject([{ actor: "person", detail: "1 run" }]);

    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(offer).toContainText("1 run on WEB-108 is under General.");
    await expect(runs).toHaveCount(0);
    expect((await workstreamEvents(page)).filter((e) => e.action === "undone").map((e) => e.detail)).toEqual(["adopted"]);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("closing a workstream (G23)", () => {
  test("offers an Undo that reopens it, says the drafts stay in General, and a closed row can be reopened", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await begin(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await expect(controls.getByRole("group", { name: "Close this workstream" })).toContainText("its agents and drafts are kept in General.");
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expectToast(page, "Closed the workstream on CA-408. Its agents and drafts are kept in General.");
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(workstreamRow(page, "CA-408")).toBeVisible();
    expect((await workstreamEvents(page)).map((e) => e.action).slice(-3)).toEqual(["opened", "closed", "reopened"]);

    // Closed again, its row under Show closed offers Reopen.
    await workstreamRow(page, "CA-408").click();
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    await pipHome(page).getByRole("button", { name: "Show closed" }).click();
    const closed = pipHome(page).getByRole("list", { name: "Closed workstreams" }).locator('[data-closed-workstream]');
    await expect(closed).toHaveCount(1);
    await closed.getByRole("button", { name: "Reopen CA-408" }).click();
    await expect(workstreamRow(page, "CA-408")).toBeVisible();
    await expect(closed).toHaveCount(0);
  });
});

test.describe("the safety copy and the glossary (G24)", () => {
  test.use({ storageState: FIRST_RUN });

  test("say a Build, and the glossary explains Manage, Hold and Allow once", async ({ page }) => {
    await page.goto("/?runs=empty");
    const card = pipHome(page).locator("[data-pip-orientation]");
    await expect(card).toContainText("a Build runs with your Claude settings and could reach Jira or GitHub on its own.");
    await expect(card).not.toContainText("an agent run with your Claude settings");
    await card.getByRole("button", { name: "What the words mean" }).click();
    for (const term of ["Manage", "Hold", "Allow once"]) await expect(card.locator("dt", { hasText: new RegExp(`^${term}$`) })).toHaveCount(1);
    await expect(card.locator("dd", { hasText: "Deny tells the agent no" })).toHaveCount(1);
  });
});

test.describe("a read-only run's permission prompt (G24)", () => {
  test("says what Deny does next to the refusal, ahead of the buttons", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await openPipHome(page);
    await expandAllNeeds(page);
    await needOfKind(page, "permission").click();
    const ask = needsPane(page).locator("[data-permission-ask]");
    await expect(ask.locator("[data-permission-refusal]")).toContainText("This run is read-only: Claude Code refuses this.");
    const note = ask.locator("[data-permission-read-only]");
    await expect(note).toHaveText("This is a read-only step, so it can't be allowed. Deny lets it carry on without it.");
    expect(await ask.evaluate((el) => !!(el.querySelector("[data-permission-read-only]")!.compareDocumentPosition(el.querySelector("[data-permission-decisions]")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });
});

test.describe("the reporter question draft (G25, G26, G29)", () => {
  test("says it posts as you and who Jira notifies, and its tag says Post like its button", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await expect(draft.locator("[data-mention-note]")).toHaveText(/^Posts as you; Jira notifies .+\.$/);
    await expect(draft.getByRole("button", { name: "Post comment" })).toBeVisible();
    await expandAllNeeds(page);
    await expect(needsYouTray(page).locator("[data-needs-you-chip]").filter({ hasText: /^Post$/ })).toHaveCount(1);
    await expect(needsYouTray(page).locator("[data-needs-you-chip]").filter({ hasText: /^Approve$/ })).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("pauses on two secrets with both buttons in the alert, Keep editing first, and quotes each", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter2\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause).toHaveAttribute("role", "alert");
    await expect(pause).toBeVisible();
    await expect(pause).toContainText("like a password, key or token at “hu…” and “gh…”.");
    await expect(pause).not.toContainText("hunter2");
    const keep = pause.getByRole("button", { name: "Keep editing" });
    const anyway = pause.getByRole("button", { name: "Post anyway" });
    await expect(keep).toBeFocused();
    await expect(keep).toHaveClass(/bg-ws-pip/);
    await expect(anyway).not.toHaveClass(/bg-ws-pip/);
    // Keep editing comes first, and the actions row has no second Post anyway.
    expect(await pause.evaluate((el) => !!(el.querySelector("[data-post-pause-keep]")!.compareDocumentPosition(el.querySelector("[data-post-pause-anyway]")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(draft.locator("[data-draft-actions]").getByRole("button", { name: /Post/ })).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    await keep.click();
    await expect(pause).toHaveCount(0);
    await expect(text).toBeFocused();
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("once posted, the sent page says who drafted it once, and where it came from", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const entry = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(entry).toBeVisible();
    await expect(entry.locator("[data-sent-edited]")).toHaveText("Gossamr drafted it; posted without changes");
    await expect(entry.locator("[data-sent-from]")).toContainText("from your request, in the workstream");
    await expect(entry.locator("[data-sent-from]")).not.toContainText("Gossamr");
  });
});

test.describe("Tab in the first-run safety sheet and the start review (G27)", () => {
  test("the safety sheet keeps Tab inside it, and in the review the disclosures come before Start agent", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
    await askPip(page, "investigate this");
    await homeSettled(page);
    const card = homeRunCards(page, "CA-401").last();
    await card.getByRole("button", { name: "Review and start", exact: true }).click();
    const sheet = safety(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    const inside = () => sheet.evaluate((el) => el.contains(document.activeElement));
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${i + 1}`).toBe(true);
    }
    await sheet.getByRole("button", { name: "Got it, continue" }).click();
    await expect(sheet).toHaveCount(0);

    // The review opened where it was asked: Tab from it reaches a disclosure before it reaches Start agent.
    const review = card.getByRole("group", { name: "Review and start" });
    await expect(review).toBeVisible();
    await review.focus();
    const start = review.getByRole("button", { name: "Start agent" });
    const seen: string[] = [];
    for (let i = 0; i < 20 && !(await start.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
      seen.push(await page.evaluate(() => document.activeElement?.tagName ?? ""));
    }
    await expect(start).toBeFocused();
    expect(seen.length, seen.join()).toBeGreaterThan(1);
    expect(seen).toContain("SUMMARY");
  });
});

test.describe("names a screen reader hears once (G28)", () => {
  test.use({ storageState: DAY_DUE });

  test("Start my day and Plan my week are one region each, not a region inside a region of the same name", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await expect(pipHome(page).getByRole("region", { name: "Start my day" })).toHaveCount(1);
    await expect(pipHome(page).locator("[data-start-my-day]")).toBeVisible();
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    await expect(pipHome(page).getByRole("region", { name: "Plan my week" })).toHaveCount(1);
    await expect(pipHome(page).locator("[data-plan-my-week]")).toBeVisible();
  });
});

test.describe("one In Needs you on a timeline row (G28)", () => {
  test("a run waiting on you says it once in the timeline, not on its line and again on its card", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await askPip(page, "investigate this");
    await homeSettled(page);
    const review = homeRunCards(page, "CA-401").last();
    await review.getByRole("button", { name: "Review and start", exact: true }).click();
    if (await safety(page).isVisible()) {
      await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    }
    await review.getByRole("button", { name: "Start agent" }).click();
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.kind === "investigate")?.id ?? null).not.toBeNull();
    const run = (await mockRuns(page)).find((r) => r.kind === "investigate")!;
    for (let i = 0; i < 2; i++) await advanceRuns(page, 1, run.id);
    await homeSettled(page);
    await askPermission(page, run.id, "approve Bash: git push origin ca-401");
    const entry = homeConversationRegion(page).locator(`[data-timeline-entry="run:${run.id}"]`);
    await expect(entry).toHaveAttribute("data-waiting", `run:${run.id}`);
    await expect(entry.getByRole("button", { name: "In Needs you" })).toHaveCount(1);
    await expect(entry.getByText("In Needs you", { exact: true })).toHaveCount(1);
  });
});

test.describe("the workstream step for a Done ticket (G30)", () => {
  test("names the one real reason, not three possible ones", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).getByRole("button", { name: "Start a workstream…" }).click();
    await palette(page).getByRole("combobox").fill("DEVOPS-478");
    await expect(palette(page)).toContainText("DEVOPS-478 is Done in Jira.");
    await expect(palette(page)).not.toContainText("It may be Done, already have a workstream, or not be loaded");
  });
});

test.describe("'start' in the palette (G31)", () => {
  test("puts Start a workstream… above Start my day", async ({ page }) => {
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("start");
    const names = await palette(page).getByRole("option").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
    const workstream = names.findIndex((n) => n.includes("Start a workstream…"));
    const day = names.findIndex((n) => n.includes("Start my day"));
    expect(workstream, names.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(day, names.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(workstream).toBeLessThan(day);
  });
});
