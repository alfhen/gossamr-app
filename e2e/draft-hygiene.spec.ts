import { expect, test, type Page } from "@playwright/test";
import { agentsHome, askPip, homeComposer, homeConversation, homeConversationRegion, homeSettled, jiraWrites, needsYouTray, openAgents, openApp, peekSheet, selectWorkstream, startWorkstream } from "./support/app";

/** Pip's and the person's move drafts of CA-401 in Pip home's conversation, as cards still open or decided. */
const moveCards = (page: Page) => homeConversationRegion(page).getByRole("article", { name: "Move CA-401", exact: true });



/** Asks Pip for `what` on Pip home and waits for its answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(homeConversationRegion(page).getByText(what, { exact: true }).last()).toBeVisible();
  await homeSettled(page);
}

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

  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  // The workstream's timeline holds its drafts, the person's own among them.
  const drafts = homeConversationRegion(page).locator("[data-timeline]");
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
  await expect(agentsHome(page)).toBeVisible();
});
