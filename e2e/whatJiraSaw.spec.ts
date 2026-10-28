import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, openAgents, openApp, peekSheet, pipCommentDraft, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// What Jira saw from me: everything Gossamr posted after the person approved it. Looking back posts nothing.

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
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

/** Pip's comment on `key`, drafted in the workstream's conversation and left waiting in the decision pane. */
async function draftOn(page: Page, key: string) {
  await openAgents(page);
  await selectWorkstream(page, key);
  return pipCommentDraft(page, key);
}

test.describe("What Jira saw from me", () => {
  test("lists what was posted by day, newest first, with the ticket, the words, where it came from and whether the person edited the draft", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await begin(page, "CA-409");

    // CA-408's comment is posted as drafted; CA-409's after the person added a line of their own.
    const first = await draftOn(page, "CA-408");
    await first.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    const second = await draftOn(page, "CA-409");
    await second.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nThe Black Friday send is next week.`);
    await second.getByRole("button", { name: "Done editing" }).click();
    await second.getByRole("button", { name: "Approve" }).click();
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
    await expect(rows.nth(0).locator("[data-sent-label]")).toHaveText("Comment");
    await expect(rows.nth(0)).toHaveAttribute("data-sent-kind", "comment");
    await expect(rows.nth(0).locator("[data-sent-edited]")).toHaveText("Pip drafted it; you edited it before approving.");
    await expect(rows.nth(0).locator("[data-sent-edited]")).toHaveAttribute("data-sent-edited", "yes");
    await expect(rows.nth(1).locator("[data-sent-edited]")).toHaveText("Pip drafted it; posted without changes.");
    await expect(rows.nth(1).locator("[data-sent-edited]")).toHaveAttribute("data-sent-edited", "no");
    await expect(rows.nth(0).locator("[data-sent-from]")).toContainText("in the workstream CA-409");

    // Short on its line, whole behind Show the posted text.
    await expect(rows.nth(0).locator("[data-sent-detail]")).toHaveCount(0);
    await rows.nth(0).getByRole("button", { name: "Show the posted text" }).click();
    await expect(rows.nth(0).locator("[data-sent-detail]")).toContainText("The Black Friday send is next week.");
    await expect(rows.nth(0).locator("[data-sent-detail]")).toContainText("Checking in on this one.");
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
