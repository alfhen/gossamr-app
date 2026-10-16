import { expect, test, type Page } from "@playwright/test";
import { editTicket, expectToast, jiraWrites, needsPane, needsYouTray, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the fourteenth dogfood round: the offer on screen is the newest action's (G3), a close offer goes once a new
// workstream opens on the ticket (G4), Reopen says why it cannot (G5) and the held-by-you banner is exact about Needs you (G10).

test.describe("Undo offers, Reopen and the held banner (G3, G4, G5, G10)", () => {
  test("the close offer goes when the ticket gets a new workstream, and Reopen is disabled with its reason", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty&wsManage=1");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Hold", exact: true }).click();
    await expect(pipHome(page).locator("[data-held-by-you]")).toContainText("You chose this, so the hold itself is not in Needs you.");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(page.locator("[data-toast]").filter({ hasText: "Closed the workstream on CA-401" })).toBeVisible();
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-401");
    await expect(page.locator("[data-toast]").filter({ hasText: "Closed the workstream on CA-401" })).toHaveCount(0);
    await openPipHome(page);
    await pipHome(page).getByRole("button", { name: "Show closed" }).click();
    const reopen = pipHome(page).locator("[data-reopen-workstream]").first();
    await expect(reopen).toHaveAttribute("aria-disabled", "true");
    await expect(pipHome(page).locator("[data-reopen-blocked]").first()).toHaveText("CA-401 already has an open workstream");
  });
});

// Keyboard and screen-reader fixes: a then Enter posts what the card shows (G1), the last need posted from the pane is announced
// (G6), focus has somewhere to go after Bring them here, Undo and Reopen (G7) and Esc at the posting pause is Keep editing (G8).

const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const activeIsBody = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);

/** The reporter question draft on a vague ticket: a workstream on it, "Ask the reporter now" pressed, its card in the decision pane. */
async function reporterDraft(page: Page) {
  await openApp(page, "runs=empty");
  await editTicket(page, "CA-408", { description: "Fix it." });
  await allProjects(page);
  await startWorkstream(page, "CA-408");
  await openPipHome(page);
  await workstreamRow(page, "CA-408").click();
  await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
  const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("approving from the list, the last need and the pause (G1, G6, G8)", () => {
  test("a then Enter on the row of a draft being edited does not post the stored text; the card's Post posts the edit", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Edited by hand before posting.");
    const row = needsYouTray(page).locator("[data-needs-you-group], [data-needs-you-need]").first();
    await row.focus();
    await page.keyboard.press("a");
    await page.keyboard.press("Enter");
    expect(await jiraWrites(page)).toEqual([]);
    await expect(needsPane(page).locator("textarea").first()).toHaveValue("Edited by hand before posting.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.text)).toEqual([expect.stringContaining("Edited by hand before posting.")]);
  });

  test("posting the only need from the pane says what was posted and that the ticket waits", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expectToast(page, "Posted to Jira: Questions for the reporter on CA-408. CA-408 now waits on the reporter; nothing starts on its own.");
  });

  test("Esc at the posting pause with the keyboard on Keep editing closes the pause and keeps the text", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pause).toHaveCount(0);
    await expect(needsPane(page)).toBeVisible();
    expect(await activeIsBody(page)).toBe(false);
    expect(await draft.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect(text).toHaveValue(/hunter2/);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("focus after Bring them here, Undo and Reopen (G7)", () => {
  test("never falls to the page, and the Under General offer is an F6 stop", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await allProjects(page);
    await startWorkstream(page, "WEB-108");
    await openPipHome(page);
    await workstreamRow(page, "WEB-108").click();
    const offer = pipHome(page).locator("[data-adopt-notice]");
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Bring them here" }).focus();
    await page.keyboard.press("F6");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-adopt-notice]"))).toBe(false);
    await offer.getByRole("button", { name: "Bring them here" }).focus();
    await page.keyboard.press("Enter");
    await expectToast(page, "Brought 1 run on WEB-108 into the workstream.");
    await expect(offer).toHaveCount(0);
    await expect.poll(() => activeIsBody(page)).toBe(false);
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).focus();
    await page.keyboard.press("Enter");
    await expect(offer.getByRole("button", { name: "Bring them here" })).toBeFocused();
  });

  test("Undo of a close and Reopen put the keyboard on the workstream's row", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).focus();
    await page.keyboard.press("Enter");
    await expect(workstreamRow(page, "CA-408")).toBeFocused();

    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    await pipHome(page).getByRole("button", { name: "Show closed" }).click();
    await pipHome(page).getByRole("button", { name: "Reopen CA-408" }).click();
    await expect(workstreamRow(page, "CA-408")).toBeFocused();
  });
});
