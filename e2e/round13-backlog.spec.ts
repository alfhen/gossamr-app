import { expect, test, type Page } from "@playwright/test";
import { agentsHome, expandAllNeeds, expectToast, homeConversationRegion, homeSettled, jiraWrites, needsPane, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream, workstreamEvents, openNeedOfKind, needsStack } from "./support/app";

// Backlog items of the thirteenth dogfood round: a workstream's offer to bring in what its ticket already has in General (G17),
// Close with an Undo and a Reopen (G23), a permission prompt saying it is answered in Terminal (G24), the posting
// pause's two buttons (G26), names a screen reader hears once (G28), the posted entry's footer (G29), the Done ticket's
// one reason (G30).

const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

/** A workstream on `key`, begun from its peek. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

/** A comment on CA-408 drafted by Pip: a workstream on it, Pip asked for a comment, its card in the decision pane. */
async function commentDraft(page: Page) {
  await openApp(page, "runs=empty");
  await begin(page, "CA-408");
  await openAgents(page);
  await selectWorkstream(page, "CA-408");
  const draft = await pipCommentDraft(page, "CA-408");
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("a workstream opened on a ticket with runs in General (G17)", () => {
  test("offers them in one line, moves them only on the button, audits it, and Undo puts them back", async ({ page }) => {
    test.setTimeout(120_000);
    // The sample's running investigation of WEB-108 was started from the board, so it sits under General.
    await openApp(page);
    await begin(page, "WEB-108");
    await openAgents(page);
    await selectWorkstream(page, "WEB-108");
    await homeSettled(page);
    const offer = agentsHome(page).locator("[data-adopt-notice]");
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

test.describe("a permission prompt", () => {
  test("says it is answered in Terminal, ahead of the one button", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await openAgents(page);
    await expandAllNeeds(page);
    await openNeedOfKind(page, "permission");
    const ask = needsPane(page).locator("[data-permission-ask]");
    const note = ask.locator("p").filter({ hasText: "you answer it in Terminal" });
    await expect(note).toBeVisible();
    expect(await ask.evaluate((el) => !!(el.querySelector("p:last-of-type")!.compareDocumentPosition(el.querySelector("[data-permission-decisions]")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });
});

test.describe("a comment draft (G26, G29)", () => {
  test("its tag says Post like its button", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await expect(draft.getByRole("button", { name: "Post comment" })).toBeVisible();
    await expect(needsStack(page).locator("[data-needs-you-chip]").filter({ hasText: /^Post$/ })).toHaveCount(1);
    await expect(needsStack(page).locator("[data-needs-you-chip]").filter({ hasText: /^Approve$/ })).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("pauses on two secrets with both buttons in the group, the note the alert, Keep editing first, and quotes each", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter2\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause).toHaveAttribute("role", "group");
    await expect(pause.locator("p[role=alert]")).toHaveCount(1);
    await expect(pause).toBeVisible();
    await expect(pause).toContainText("like a password, key or token at “hu…” (line 3) and “gh…” (line 4).");
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
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const entry = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(entry).toBeVisible();
    await expect(entry.locator("[data-sent-edited]")).toHaveText("Pip drafted it; posted without changes.");
    await expect(entry.locator("[data-sent-from]")).toContainText("from Pip, in the workstream");
    await expect(entry.locator("[data-sent-from]")).not.toContainText("Gossamr");
  });
});
