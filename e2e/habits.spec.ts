import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  editTicket,
  expectToast,
  homeConversationRegion,
  jiraWrites,
  needsPane,
  needsYouCount,
  openApp,
  openPipHome,
  peekSheet,
  pipHome,
  pipPane,
  seedWorkstreamEvent,
  startWorkstream,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

// The habits that make the owner look at their tickets and at what goes to Jira: Start my day, What Jira saw from me, a clarity
// notice that learns from Looks fine, and a nudge for a reporter who hasn't answered. None of them posts anything by itself.

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside: the card is due. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const THIN = "Fix it.";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const card = (page: Page) => pipHome(page).locator("[data-start-my-day]");
const line = (page: Page, kind: string) => card(page).locator(`[data-day-line="${kind}"]`);
const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");
const nextLine = (page: Page) => pipHome(page).locator("[data-next-step]");
const toast = (page: Page) => page.locator("[data-toast]");
const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

async function runCommand(page: Page, query: string, option: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(query);
  await palette(page).getByRole("option", { name: option }).first().click();
  await expect(palette(page)).toHaveCount(0);
}

/** A workstream on ticket `key`, begun from its peek; leaves the workspace behind it. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

/** The questions to the reporter on `key`, asked from its notice and left waiting as a draft. */
async function askNow(page: Page, key: string) {
  await openPipHome(page);
  await workstreamRow(page, key).click();
  await notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
  return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
}

/** CA-408 waits on the reporter: asked and posted `days` days ago, as the audit would say it. */
async function waitingOn(page: Page, days: number) {
  await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "clarity_asked", at: ago(days + 0.1), proposalId: "old-ask" });
  await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "draft_approved", at: ago(days), proposalId: "old-ask" });
}

test.describe("Start my day", () => {
  test.use({ storageState: DAY_DUE });

  test("gathers the day at the top of Pip home, each line a click from its thing, and Done for now keeps it away until tomorrow; the palette brings it back", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    // CA-408 waits on its reporter, CA-402's questions to the reporter wait for approval, CA-409 reads thin.
    await startWorkstream(page, "CA-408");
    await begin(page, "CA-402");
    await begin(page, "CA-409");
    await waitingOn(page, 3);
    const draft = await askNow(page, "CA-402");
    await expect(draft).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(needsPane(page)).toHaveCount(0);

    // It is General's card, the first thing in the conversation column, a region of its own.
    await workstreamRow(page, "General").click();
    await expect(card(page)).toBeVisible();
    await expect(homeConversationRegion(page).locator("[data-start-my-day]")).toBeVisible();
    await expect(card(page).getByRole("heading", { name: "Start my day" })).toBeVisible();
    await expect(line(page, "approve").getByRole("heading")).toHaveText("1 to approve");
    await expect(line(page, "reporter").getByRole("heading")).toHaveText("1 waiting on the reporter");
    await expect(line(page, "reporter")).toContainText("CA-408 · waiting 3 days");
    await expect(line(page, "reporter").getByRole("button", { name: /^Draft a nudge/ })).toBeVisible();
    // The draft has a need, so it is listed once, under approve, and not again as a waiting draft.
    await expect(line(page, "drafts")).toHaveCount(0);
    // A long list of unclear tickets is a count; More lists them.
    await expect(line(page, "unclear").getByRole("heading")).toContainText("may be unclear");
    await line(page, "unclear").getByRole("button", { name: "More" }).click();
    await expect(line(page, "unclear")).toContainText("CA-409 may be unclear: it has no description.");
    // It counts nowhere and writes nothing.
    await expect(needsYouCount(page)).toHaveText("1");
    expect(await jiraWrites(page)).toEqual([]);

    // The unclear ticket: its workstream, where the notice is.
    await line(page, "unclear").getByRole("button", { name: /^Open workstream: CA-409/ }).click();
    await expect(workstreamRow(page, "CA-409")).toHaveAttribute("aria-selected", "true");
    await expect(notice(pipHome(page))).toContainText("CA-409 may be unclear");

    // The workstream has no card of its own: Start my day is General's.
    await expect(card(page)).toHaveCount(0);
    await workstreamRow(page, "General").click();

    // The draft waiting: its decision opens in the pane, and the card gives the room.
    await line(page, "approve").getByRole("button", { name: /^Open: .*CA-402/ }).click();
    await expect(needsPane(page).getByRole("article", { name: "Comment on CA-402" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(needsPane(page)).toHaveCount(0);
    await workstreamRow(page, "General").click();
    await expect(card(page)).toBeVisible();
    expect(await jiraWrites(page)).toEqual([]);

    // What Jira saw from me is one click away, and it is empty: nothing was posted.
    await card(page).getByRole("button", { name: "What Jira saw from me" }).click();
    await expect(page.locator("[data-jira-sent]").getByRole("heading", { name: "What Jira saw from me" })).toBeVisible();
    await expect(page.locator("[data-jira-sent]")).toContainText("No posts to Jira from Gossamr are on record here.");
    await openPipHome(page);

    // Done for now: gone for the day, and gone after a reload.
    await card(page).getByRole("button", { name: "Done for now" }).click();
    await expect(card(page)).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}").startMyDayDoneOn);
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.reload();
    await openPipHome(page);
    await expect(workstreamRow(page, "General")).toBeVisible();
    await expect(card(page)).toHaveCount(0);

    // ⌘K brings it back, with the keyboard on it.
    await runCommand(page, "start my day", "Start my day");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toBeFocused();
  });

  test("is a draft of the nudge for a reporter who hasn't answered, never a post", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await waitingOn(page, 4);
    await openPipHome(page);
    await expect(line(page, "reporter")).toContainText("CA-408 · waiting 4 days");
    await line(page, "reporter").getByRole("button", { name: /^Draft a nudge/ }).click();
    const nudge = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(nudge).toContainText("The earlier questions about CA-408 are still open");
    await expect(nudge.locator('[data-created-by="gossamr"]')).toHaveText("Drafted by Gossamr");
    expect(await jiraWrites(page)).toEqual([]);
    expect((await actions(page, "reporter_nudged")).map((e) => e.actor)).toEqual(["person"]);
    // The card gave the room to the decision; once it closes, the line says a nudge is drafted and offers none.
    await page.keyboard.press("Escape");
    await workstreamRow(page, "General").click();
    await expect(line(page, "reporter")).toContainText("a nudge is drafted");
    await expect(line(page, "reporter").getByRole("button", { name: /Draft a nudge/ })).toHaveCount(0);
    await expect(line(page, "reporter").getByRole("button", { name: /^Open workstream/ })).toBeVisible();
  });
});

test.describe("the reporter nudge", () => {
  test("is offered on the Next line and the workstream's row once the reporter was silent for 2 days, drafts a polite comment for approval, and a posted nudge starts the wait again", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await waitingOn(page, 1.5);
    await expect(workstreamRow(page, "CA-408").locator("[data-status]")).toHaveText("Waiting on reporter");
    // Under two days: said, and no offer.
    await expect(nextLine(page)).toHaveText("Next: Waiting on the reporter since yesterday; nothing starts on its own.");
    await expect(nextLine(page).getByRole("button", { name: "Draft a nudge" })).toHaveCount(0);
    await expect(workstreamRow(page, "CA-408").locator("[data-nudge-due]")).toHaveCount(0);

    // Two days or more: the Next line says how long and offers it, and the row says a nudge is due. It is no need.
    await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "clarity_asked", at: ago(3.2), proposalId: "older-ask" });
    await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "draft_approved", at: ago(3.1), proposalId: "older-ask" });
    await expect(nextLine(page)).toContainText("Waiting on the reporter since 3 days ago; nothing starts on its own. The reporter hasn't answered for 3 days. You can draft a nudge.");
    await expect(workstreamRow(page, "CA-408").locator("[data-nudge-due]")).toHaveText("· nudge due");
    await expect(needsYouCount(page)).toHaveText("0");

    await nextLine(page).getByRole("button", { name: "Draft a nudge" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft).toContainText("@Mette Lund");
    await expect(draft).toContainText("The earlier questions about CA-408 are still open");
    await expect(draft.locator('[data-created-by="gossamr"]')).toHaveText("Drafted by Gossamr");
    expect(await jiraWrites(page)).toEqual([]);
    // One at a time: no second offer while it waits, and it is a draft in Needs you, never in a safe batch.
    await expect(nextLine(page).getByRole("button", { name: "Draft a nudge" })).toHaveCount(0);
    await expect(workstreamRow(page, "CA-408").locator("[data-nudge-due]")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("1");
    await expect(pipHome(page).getByRole("button", { name: /Approve \d+ safe drafts/ })).toHaveCount(0);

    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", "CA-408"]]);
    // Posted: it waits on the reporter again from now, so the next nudge is days away.
    await expect(nextLine(page)).toHaveText("Next: Waiting on the reporter since just now; nothing starts on its own.");
    await expect(nextLine(page).getByRole("button", { name: "Draft a nudge" })).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });
});

test.describe("What Jira saw from me", () => {
  test("lists what was posted by day, newest first, with the ticket, the words, where it came from and whether the person edited the draft", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await begin(page, "CA-409");

    // CA-408's questions are posted as drafted; CA-409's after the person added a line of their own.
    const first = await askNow(page, "CA-408");
    await first.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    const second = await askNow(page, "CA-409");
    await second.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nThe Black Friday send is next week.`);
    await second.getByRole("button", { name: "Done editing" }).click();
    await second.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(2);

    await runCommand(page, "what jira saw", "What Jira saw from me");
    const view = page.locator("[data-jira-sent]");
    await expect(view.getByRole("heading", { name: "What Jira saw from me" })).toBeVisible();
    await expect(view.getByRole("region", { name: "Today" })).toBeVisible();
    const rows = view.locator("[data-sent-entry]");
    await expect(rows).toHaveCount(2);
    // Newest first.
    await expect(rows.nth(0)).toContainText("CA-409");
    await expect(rows.nth(1)).toContainText("CA-408");
    await expect(rows.nth(0).locator("[data-sent-label]")).toHaveText("Questions to the reporter");
    await expect(rows.nth(0)).toHaveAttribute("data-sent-kind", "comment");
    await expect(rows.nth(0).locator("[data-sent-edited]")).toHaveText("Gossamr drafted it; you edited it before approving.");
    await expect(rows.nth(0).locator("[data-sent-edited]")).toHaveAttribute("data-sent-edited", "yes");
    await expect(rows.nth(1).locator("[data-sent-edited]")).toHaveText("Gossamr drafted it; posted without changes.");
    await expect(rows.nth(1).locator("[data-sent-edited]")).toHaveAttribute("data-sent-edited", "no");
    await expect(rows.nth(0).locator("[data-sent-from]")).toContainText("in the workstream CA-409");

    // Short on its line with the line after the opener under it, whole behind Show the posted text.
    await expect(rows.nth(0).locator("[data-sent-detail]")).toHaveCount(0);
    await expect(rows.nth(0).locator("[data-sent-second]")).toContainText("- ");
    await rows.nth(0).getByRole("button", { name: "Show the posted text" }).click();
    await expect(rows.nth(0).locator("[data-sent-detail]")).toContainText("The Black Friday send is next week.");
    await expect(rows.nth(0).locator("[data-sent-detail]")).toContainText("A few things about CA-409 need clearing up");
    await rows.nth(0).getByRole("button", { name: "Show less" }).click();
    await expect(rows.nth(0).locator("[data-sent-detail]")).toHaveCount(0);

    // Links lead to the workstream and the ticket.
    await rows.nth(1).locator("[data-sent-workstream]").click();
    await expect(workstreamRow(page, "CA-408")).toHaveAttribute("aria-selected", "true");
    await runCommand(page, "what jira saw", "What Jira saw from me");
    await view.locator("[data-sent-entry]").nth(1).locator("[data-sent-ticket]").click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-408");
    // Looking back posts nothing more.
    expect(await jiraWrites(page)).toHaveLength(2);
  });

  test("says so while nothing was posted", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await runCommand(page, "what jira saw", "What Jira saw from me");
    await expect(page.locator("[data-jira-sent]")).toContainText("No posts to Jira from Gossamr are on record here.");
    await expect(page.locator("[data-sent-entry]")).toHaveCount(0);
  });
});

test.describe("the clarity notice learns from Looks fine", () => {
  test("stops flagging the same gap in one project after the third, audited, in Settings and the palette to give back", async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, "runs=empty");
    for (const key of ["CA-402", "CA-409", "CA-209"]) await editTicket(page, key, { description: THIN });
    for (const key of ["CA-402", "CA-409"]) {
      await begin(page, key);
      await notice(pipPane(page)).getByRole("button", { name: "Looks fine" }).click();
      await expect(notice(pipPane(page))).toHaveCount(0);
      await expect(toast(page).filter({ hasText: "Gossamr will stop flagging" })).toHaveCount(0);
    }
    await begin(page, "CA-209");
    await expect(notice(pipPane(page))).toContainText("CA-209 may be unclear: it has a very short description");
    await notice(pipPane(page)).getByRole("button", { name: "Looks fine" }).click();
    await expectToast(page, "Gossamr will stop flagging CA tickets that have a very short description, or that don't say what done looks like");
    // Each gap learned is in the audit, and so is each dismissal.
    expect((await actions(page, "clarity_learned")).map((e) => [e.actor, e.detail])).toEqual([["person", "short in CA"], ["person", "done in CA"], ["person", "scope in CA"], ["person", "who in CA"]]);
    expect(await actions(page, "clarity_dismissed")).toHaveLength(3);
    expect(await jiraWrites(page)).toEqual([]);

    // A fourth thin ticket in the same project is not remarked on; another project's still is.
    await editTicket(page, "CA-208", { description: THIN });
    await begin(page, "CA-208");
    await expect(pipPane(page).locator("[data-pip-conversation]")).toContainText("CA-208");
    await expect(notice(pipPane(page))).toHaveCount(0);
    await begin(page, "DEVOPS-475");
    await expect(notice(pipPane(page))).toContainText("DEVOPS-475 may be unclear");

    // Settings says what it learned and gives it back for the project.
    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    const learned = page.locator("[data-clarity-learning]");
    await expect(learned.locator('[data-clarity-project="CA"]')).toContainText("short description");
    await learned.locator('[data-clarity-project="CA"]').getByRole("button", { name: "Give back all" }).click();
    await expect(learned).toContainText("Nothing learned yet.");
    await expectToast(page, "Gossamr will flag new unclear CA tickets as before.");
    expect((await actions(page, "clarity_reset")).map((e) => [e.actor, e.detail])).toEqual([["person", "CA"]]);
    // CA-208's notice is back, since the gaps are flagged again.
    await openPipHome(page);
    await workstreamRow(page, "CA-208").click();
    await expect(notice(pipHome(page))).toContainText("CA-208 may be unclear");
  });

  test("is given back from the palette, and a thin ticket in the project is flagged again", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, "runs=empty");
    for (const key of ["CA-403", "CA-405", "CA-406", "CA-407"]) await editTicket(page, key, { description: THIN });
    for (const key of ["CA-403", "CA-405", "CA-406"]) {
      await begin(page, key);
      await notice(pipPane(page)).getByRole("button", { name: "Looks fine" }).click();
      await expect(notice(pipPane(page))).toHaveCount(0);
    }
    await expectToast(page, "Gossamr will stop flagging CA tickets");
    await begin(page, "CA-407");
    await expect(pipPane(page).locator("[data-pip-conversation]")).toContainText("CA-407");
    await expect(notice(pipPane(page))).toHaveCount(0);
    await runCommand(page, "give back", "Give back what Looks fine learned");
    await expect(notice(pipPane(page))).toContainText("CA-407 may be unclear");
    expect((await actions(page, "clarity_reset")).map((e) => [e.actor, e.detail])).toEqual([["person", "CA"]]);
  });
});
