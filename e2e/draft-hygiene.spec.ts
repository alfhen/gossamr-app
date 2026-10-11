import { expect, test, type Page } from "@playwright/test";
import { askPip, homeComposer, homeConversation, homeConversationRegion, homeSettled, jiraWrites, needsYouTray, openApp, openPipHome, peekSheet, pipHome, startWorkstream, stepRail, workstreamEvents, workstreamRow } from "./support/app";

/** Pip's and the person's move drafts of CA-401 in Pip home's conversation, as cards still open or decided. */
const moveCards = (page: Page) => homeConversationRegion(page).getByRole("article", { name: "Move CA-401", exact: true });

/** The one-line form a retired draft of CA-401 collapses to in the conversation. */
const retiredMoves = (page: Page) => homeConversationRegion(page).locator("[data-retired-draft]");

/** Starts a workstream on CA-401 from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page) {
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
}

/** Asks Pip for `what` on Pip home and waits for its answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(homeConversationRegion(page).getByText(what, { exact: true }).last()).toBeVisible();
  await homeSettled(page);
}

test("a second move Pip drafts for the workstream's ticket replaces its first, which collapses with the reason and points at the newer one", async ({ page }) => {
  await openApp(page, "runs=empty");
  await homeWorkstream(page);

  await ask(page, "move it to QA");
  await expect(moveCards(page)).toHaveCount(1);
  await ask(page, "move it to Copy");

  // The first card folds to one line saying why; the newer one is the only open move.
  await expect(retiredMoves(page)).toHaveCount(1);
  const old = retiredMoves(page).first();
  await expect(old).toContainText("Move CA-401");
  await expect(old).toContainText("Out of date · Replaced by a newer draft");
  await expect(old.getByRole("article")).toHaveCount(0);
  await expect(moveCards(page)).toHaveCount(1);
  await expect(moveCards(page)).toContainText("Move CA-401 to Copy");
  await expect(moveCards(page)).toHaveAttribute("data-state", "pending");
  const newer = await moveCards(page).getAttribute("data-draft");
  await expect(old).toHaveAttribute("data-superseded-by", newer!);

  // Show the newer draft takes the keyboard to it.
  await old.getByRole("button", { name: "Show the newer draft" }).click();
  await expect(moveCards(page)).toBeFocused();

  // Opened, the whole first card is there again, decided.
  await old.getByRole("button", { name: /Move CA-401/ }).click();
  await expect(old.getByRole("article", { name: "Move CA-401" })).toContainText("Move CA-401 to QA");
  await expect(old.getByRole("article", { name: "Move CA-401" })).toHaveAttribute("data-state", "retired");

  // The tray counts the one draft still waiting, and the rail keeps the first as an earlier draft with its reason.
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).toHaveText("1");
  const earlier = stepRail(page).locator('[data-earlier-drafts="pip"]');
  await expect(earlier.getByRole("button", { name: "1 earlier draft" })).toBeVisible();
  await earlier.getByRole("button", { name: "1 earlier draft" }).click();
  await expect(earlier.locator("[data-earlier-draft]")).toHaveText("Move CA-401 · Replaced by a newer draft");

  const superseded = (await workstreamEvents(page)).filter((e) => e.action === "draft_superseded");
  expect(superseded.map((e) => [e.actor, e.detail])).toEqual([["pip", newer]]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("approving Pip's move from the keyboard retires the person's own move of the same ticket, and Jira gets one transition", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-401");

  // The person drags CA-401 to Copy on the board: their own draft, nothing written.
  await peekSheet(page).getByRole("button", { name: "Close details" }).click();
  await expect(peekSheet(page)).toHaveCount(0);
  const views = page.getByRole("group", { name: "View" });
  await views.getByRole("button", { name: "Board" }).click();
  await page.getByRole("group", { name: "Projects" }).getByRole("button", { name: "Campaigns" }).click();
  const board = page.locator('section[aria-label$=" board"]');
  await board.getByText("CA-401", { exact: true }).dragTo(board.getByRole("group", { name: /^Copy, / }));
  await expect(board.getByRole("group", { name: /^Copy, / }).getByRole("article", { name: "Draft: CA-401 moves here" })).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);

  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  const drafts = homeConversationRegion(page).getByRole("region", { name: "Drafts" });
  await expect(drafts.getByRole("article", { name: "Move CA-401" })).toContainText("Move CA-401 to Copy");

  await ask(page, "move it to QA");
  await expect(moveCards(page)).toHaveCount(2);

  // ArrowUp from the empty composer reaches Pip's draft, the newest; a then Enter approves it.
  await homeComposer(page).focus();
  await homeComposer(page).press("ArrowUp");
  const pips = moveCards(page).last();
  await expect(pips).toBeFocused();
  await expect(pips).toContainText("Move CA-401 to QA");
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await expect(pips).toHaveAttribute("data-state", "applied");

  // The person's move folds to one line saying why, in place.
  const theirs = drafts.locator("[data-retired-draft]");
  await expect(theirs).toHaveCount(1);
  await expect(theirs).toContainText("Out of date · Another move of CA-401 was approved");
  await expect(theirs.getByRole("button", { name: "Show the newer draft" })).toHaveCount(0);
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).toHaveText("0");

  const writes = await jiraWrites(page);
  expect(writes.filter((w) => w.type === "transition")).toHaveLength(1);
  expect(writes.map((w) => w.key)).toEqual(["CA-401"]);
  await expect(pipHome(page)).toBeVisible();
});
