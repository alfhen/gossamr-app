import { expect, test, type Locator, type Page } from "@playwright/test";
import { agentsHome, editTicket, expectToast, jiraWrites, needsPane, openAgents, openApp, peekSheet, pipPane, selectWorkstream, startWorkstream, workstreamEvents, workstreamGroup } from "./support/app";

// The habits that make the owner look at their tickets and at what goes to Jira: What Jira saw from me, a clarity
// notice that learns from Looks fine, and a nudge for a reporter who hasn't answered. None of them posts anything by itself.


const THIN = "Fix it.";
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");
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
  await openAgents(page);
  await selectWorkstream(page, key);
  await notice(agentsHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
  return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
}


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
    await expect(rows.nth(0).locator("[data-sent-detail]")).toContainText("A few things need clearing up to make this ticket clear to work on");
    await rows.nth(0).getByRole("button", { name: "Show less" }).click();
    await expect(rows.nth(0).locator("[data-sent-detail]")).toHaveCount(0);

    // Links lead to the workstream and the ticket.
    await rows.nth(1).locator("[data-sent-workstream]").click();
    await expect(workstreamGroup(page, "CA-408")).toHaveAttribute("aria-current", "true");
    await runCommand(page, "what jira saw", "What Jira saw from me");
    await view.locator("[data-sent-entry]").nth(1).locator("[data-sent-ticket]").click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-408");
    // Looking back posts nothing more.
    expect(await jiraWrites(page)).toHaveLength(2);
  });

  test("says so while nothing was posted", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
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
    await openAgents(page);
    await selectWorkstream(page, "CA-208");
    await expect(notice(agentsHome(page))).toContainText("CA-208 may be unclear");
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
