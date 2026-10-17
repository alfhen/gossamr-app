import { expect, test, type Page } from "@playwright/test";
import { editTicket, expectToast, jiraWrites, needsPane, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Backlog items of the fourteenth dogfood round: a posted secret masked on What Jira saw from me (G26), the clarity notice not
// announced when a workstream opens (G28), the comment's edit box and the closed list having room (G29) and the note about the
// reporter comment going when its workstream is closed (G30).

const THIN = "Fix it.";
const toast = (page: Page) => page.locator("[data-toast]");
const notice = (page: Page) => pipHome(page).locator("[data-clarity-notice]");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const NOTE = "Here is the comment to the reporter. Nothing is posted until you press Post comment.";

/** The reporter question draft on a vague ticket: a workstream on it, "Ask the reporter now" pressed, its card in the decision pane. */
async function reporterDraft(page: Page) {
  await openApp(page, "runs=empty");
  await editTicket(page, "CA-408", { description: THIN });
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openPipHome(page);
  await workstreamRow(page, "CA-408").click();
  await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
  const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("a posted secret on What Jira saw from me (G26)", () => {
  test("is masked, with the rest of the text kept and a note saying so", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter22secret`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await draft.locator("[data-post-pause]").getByRole("button", { name: "Post anyway" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    // The pause's line numbers are for the pause only: the posted text carries none.
    expect((await jiraWrites(page))[0].text).not.toMatch(/\(line \d+\)/);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("what jira saw");
    await page.keyboard.press("Enter");
    const entry = page.locator("[data-jira-sent] [data-sent-entry]").first();
    await expect(entry).toBeVisible();
    await expect(entry.locator("[data-sent-masked]")).toContainText("looked like a password, key or token and is hidden here");
    await entry.getByRole("button", { name: /^Show the posted text/ }).click();
    const detail = entry.locator("[data-sent-detail]");
    await expect(detail).toContainText("Password: hu…");
    await expect(detail).not.toContainText("hunter22secret");
    await expect(detail).not.toContainText("(line ");
    await expect(entry).not.toContainText("hunter22secret");
    // The rest of the comment is still there.
    await expect(detail).toContainText("What is the goal?");
  });
});

test.describe("the clarity notice (G28)", () => {
  test("announces nothing from its live region when the workstream opens", async ({ page }) => {
    test.setTimeout(120_000);
    await reporterDraftOpen(page);
    await expect(notice(page)).toBeVisible();
    await expect(pipHome(page).locator("[data-clarity-status]")).toHaveText("");
    await expect(notice(page)).toHaveAttribute("role", "group");
  });
});

/** A workstream on the thinned CA-408, open on Pip home with its notice showing. */
async function reporterDraftOpen(page: Page) {
  await openApp(page, "runs=empty");
  await editTicket(page, "CA-408", { description: THIN });
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openPipHome(page);
  await workstreamRow(page, "CA-408").click();
}

test.describe("room to edit and to read the closed list (G29)", () => {
  test("the comment's edit box is about six lines tall at least", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const box = await needsPane(page).locator("textarea").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(150);
  });

  test("the closed list has a scroll area of its own that the workstreams above keep their room beside", async ({ page }) => {
    test.setTimeout(120_000);
    await reporterDraftOpen(page);
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    const list = pipHome(page).getByRole("listbox", { name: "Workstreams" });
    const before = (await list.boundingBox())!.height;
    await pipHome(page).getByRole("button", { name: "Show closed" }).click();
    const closed = pipHome(page).getByRole("list", { name: "Closed workstreams" });
    await expect(closed.locator("[data-closed-workstream]")).toHaveCount(1);
    expect(await closed.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    // Showing the closed list leaves the workstreams as much room as it can: General stays visible, and the list is not squeezed away.
    await expect(list.locator('[data-workstream-row="general"]')).toBeVisible();
    expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(Math.min(before, 80));
    expect((await closed.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  });
});

test.describe("closing a workstream with a comment to the reporter waiting (G30)", () => {
  test("takes the note back, and Undo of the close does not bring it up again", async ({ page }) => {
    test.setTimeout(120_000);
    await reporterDraft(page);
    await expectToast(page, NOTE);
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expectToast(page, "Closed the workstream on CA-408. Its agents and drafts are kept in General.");
    await expect(toast(page).filter({ hasText: NOTE })).toHaveCount(0);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expectToast(page, "Reopened the workstream on CA-408.");
    await expect(toast(page).filter({ hasText: NOTE })).toHaveCount(0);
  });
});
