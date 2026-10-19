import { expect, test, type Page } from "@playwright/test";
import {
  askPip,
  blockRun,
  expandNeedsYou,
  homeConversation,
  homeConversationRegion,
  holdBySystem,
  homeSettled,
  jiraWrites,
  loseRun,
  mockAttached,
  mockRuns,
  needRow,
  needsPane,
  needsPaneHeading,
  needsYouCount,
  needsYouRow,
  needsYouTray,
  openApp,
  openPipHome,
  pipHome,
  startWorkstream,
  stopRunAtLimit,
  workstreamRow,
} from "./support/app";

// One Needs you (docs/needs-you.md): a list of what waits on the person, one count everywhere, and each decision made in
// a pane beside the conversation.

const MANAGED = "wsManage=1";

/** The rail's Pip home and Agents buttons. */
const homeButton = (page: Page) => page.getByRole("button", { name: /^Pip home/ });
const agentsButton = (page: Page) => page.getByRole("button", { name: /^Agents/ });

/** Pip home's composer footer, which says how many need the person. */
const footer = (page: Page) => homeConversationRegion(page).locator("[data-composer-footer]");

const need = needRow;

/** The sample's run on ticket `key` (the first, when it has several). */
const runOn = async (page: Page, key: string) => (await mockRuns(page)).find((r) => r.key === key)!;
const stateOf = async (page: Page, id: string) => (await mockRuns(page)).find((r) => r.id === id)?.state;

/** Whether the keyboard is inside the open decision. */
const focusInPane = (page: Page) => page.evaluate(() => !!document.querySelector("[data-needs-pane]")?.contains(document.activeElement));

/** Pip home with the sample's own runs (a permission, a question, a failure to retry and a quiet run, all in General), ready. */
async function onHome(page: Page, query = "") {
  await openApp(page, query);
  await expect(agentsButton(page)).toHaveCount(1);
  await openPipHome(page);
  await expect(needsYouTray(page)).toBeVisible();
}

const expandGeneral = (page: Page) => expandNeedsYou(page, "General");

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

/** Pip home opens a group by default while its needs fit: folds them all, for the tests that read the folded list. */
async function foldAll(page: Page) {
  const open = needsYouTray(page).locator('[data-needs-you-more][aria-expanded="true"]');
  while (await open.count()) await open.first().click();
}

test("one row per workstream, with '+N more' for the rest, and one count on the rail, in the list and under the composer", async ({ page }) => {
  await openApp(page, MANAGED);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  // The sample leaves CA-401's plan to approve; the workstream gets a hold (a restart's: the person's own Hold is no need) and a draft of Pip's: three needs, one row.
  await holdBySystem(page, "CA-401", "restart");
  await askPip(page, "Draft a comment");
  await homeSettled(page);

  const rows = needsYouTray(page).locator("[data-needs-you-row]");
  await expect(rows).toHaveCount(2);
  const ws = needsYouRow(page, "CA-401");
  await expect(ws).toHaveCount(1);
  // Open by default: the group is its name and count, with every need listed once under it.
  await expect(ws.locator("[data-needs-you-more]")).toHaveText("Show less");
  await expect(ws.locator("[data-needs-you-need]")).toHaveCount(3);
  await foldAll(page);
  await expect(ws.locator("[data-needs-you-more]")).toHaveText("+2 more");
  // The plan is a decision, which ranks above what is stuck and what waits for an approval.
  await expect(ws.locator("[data-needs-you-chip]")).toHaveText("Decide");
  await expect(ws).toContainText("approving its description update is how the plan is approved");
  // General's three (a permission, a question and a failure; a run gone quiet is no need) are one row too.
  const general = needsYouRow(page, "General");
  await expect(general.locator("[data-needs-you-more]")).toHaveText("+2 more");
  await expect(general.locator("[data-needs-you-need]")).toHaveCount(0);

  // The group's first need leads; opening the row lists them all, in rank order.
  await ws.locator("[data-needs-you-more]").click();
  await expect(ws.locator("[data-needs-you-need]")).toHaveCount(3);
  await expect(ws.locator("[data-needs-you-need]").nth(0)).toContainText("Approve the plan");
  await expect(ws.locator("[data-needs-you-need]").nth(1)).toContainText("Held after a restart");
  await expect(ws.locator("[data-needs-you-need]").nth(2)).toContainText("Draft comment");
  await ws.locator("[data-needs-you-more]").click();
  await expect(ws.locator("[data-needs-you-need]")).toHaveCount(0);

  // The one count: the list's pill, the rail's badge and the composer say the same six, and Agents carries none.
  await expect(needsYouCount(page)).toHaveText("6");
  await expect(homeButton(page)).toHaveAccessibleName("Pip home, 6 things need you");
  await expect(homeButton(page).locator('[aria-label="6 things need you"]')).toHaveText("6");
  await expect(footer(page)).toHaveText(/ · 6 need you$/);
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toHaveCount(1);
  await expect(agentsButton(page).locator("span[aria-label]")).toHaveCount(0);
  await expect(workstreamRow(page, "CA-401").locator("[data-status]")).toHaveText("Needs you");
  await expect(workstreamRow(page, "CA-401").locator("[data-status-detail]")).toHaveText("· 3 waiting");
});

test("deciding a permission from the pane: Deny, then focus is on the next need", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const before = await needsYouCount(page).innerText();
  const permission = need(page, /DEVOPS-471.*asks to run a command/);
  await permission.click();

  const pane = needsPane(page);
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("wants to run `git push origin HEAD`.");
  await expect(pane).toContainText("If you wait:");
  await expect(pane).toContainText("The run stays paused; nothing else in DEVOPS-471 moves.");
  await expect(pane.getByRole("button", { name: "Open the run" })).toBeVisible();
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  const first = (await pane.getAttribute("data-needs-pane"))!;
  // The decision has the keyboard as it opens.
  await expect.poll(() => focusInPane(page)).toBe(true);

  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await pane.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(() => stateOf(page, run.id)).toBe("working");
  // It leaves the list, the count drops by one, and the next need opens in the pane with the keyboard in it.
  await expect(needsYouCount(page)).toHaveText(String(Number(before) - 1));
  await expect(need(page, /DEVOPS-471/)).toHaveCount(0);
  await expect(pane).not.toHaveAttribute("data-needs-pane", first);
  await expect(pane).toHaveAttribute("data-needs-pane", /./);
  await expect.poll(() => focusInPane(page)).toBe(true);
});

test("answering a question from the pane sends it to the run, which leaves Needs you", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const before = Number(await needsYouCount(page).innerText());
  await need(page, /CA-409.*asks a question/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("asks: “Should the refund path keep the old rounding?”");
  await expect(pane).toContainText("The run stays paused until you answer");
  const run = await runOn(page, "CA-409");
  expect(await stateOf(page, run.id)).toBe("needsAnswer");

  const answer = pane.getByRole("textbox", { name: "Your answer" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await answer.fill("Yes, keep the old rounding.");
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expect.poll(() => stateOf(page, run.id)).toBe("working");
  await expect(need(page, /CA-409/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(before - 1));
  // Focus moved on to the next need rather than being lost.
  await expect.poll(() => focusInPane(page)).toBe(true);
});

test("approving a draft from the pane writes it to Jira, and focus goes to the next need; Esc comes back to the list", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await holdBySystem(page, "CA-401", "restart");
  await expect(needsYouCount(page)).toHaveText("2");

  const ws = needsYouRow(page, "CA-401");
  await expect(ws.locator("[data-needs-you-need]").first()).toBeVisible();
  await need(page, /Draft comment/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("drafted a comment on CA-401.");
  await expect(pane).toContainText("Nothing is written to Jira until you approve it.");
  await expect(pane.locator("article[data-draft]")).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);

  // Esc goes back to the list with the keyboard on the need's row.
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(need(page, /Draft comment/)).toBeFocused();

  await need(page, /Draft comment/).click();
  await pane.getByRole("button", { name: "Post comment" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  await expect(need(page, /Draft comment/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText("1");
  // The hold is next: its decision opens in the pane, with Resume.
  await expect(pane).toHaveAttribute("data-kind", "hold");
  await expect(pane.locator("[data-held-banner]").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect.poll(() => focusInPane(page)).toBe(true);
  await pane.getByRole("button", { name: "Resume" }).click();
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
  await expect(pane).toHaveCount(0);
  await expect(homeButton(page)).toHaveAccessibleName("Pip home");
  await expect(footer(page)).toHaveText(/nothing needs you$/);
});

test("'Approve N safe drafts' approves comments and moves together after one confirm, with what each does shown first", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "move it to QA");
  await homeSettled(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("3");

  const ws = needsYouRow(page, "CA-401");
  // Folded, there is no batch yet; expanded, it is offered with the number.
  await foldAll(page);
  await expect(ws.getByRole("button", { name: /safe drafts/ })).toHaveCount(0);
  await ws.locator("[data-needs-you-more]").click();
  const batch = ws.getByRole("button", { name: "Approve 3 safe drafts" });
  await batch.click();
  // The preview opens in the decision pane like any other decision, not inside the cramped list.
  const pane = needsPane(page);
  await expect(pane).toHaveAttribute("data-kind", "batch");
  await expect(needsYouTray(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);
  const preview = pane.locator("[data-needs-you-batch-preview] li");
  await expect(preview).toHaveCount(3);
  await expect(preview.first()).toContainText(/Comment on CA-401|Move CA-401/);
  expect(await jiraWrites(page)).toEqual([]);

  // Cancel keeps them all, and closes the pane.
  await pane.getByRole("button", { name: "Cancel" }).click();
  await expect(pane).toHaveCount(0);
  expect(await jiraWrites(page)).toEqual([]);
  await expect(needsYouCount(page)).toHaveText("3");

  await batch.click();
  await pane.getByRole("button", { name: "Yes, approve 3" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type).sort()).toEqual(["comment", "comment", "transition"]);
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

test("a failure stays in Needs you after Agents is opened, and only a Dismiss (or a fix) takes it out", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const count = Number(await needsYouCount(page).innerText());
  const failure = need(page, /SUP-9.*needs its folder trusted/);
  await expect(failure).toHaveCount(1);

  // Opening Agents (the failed run is on screen there, as it always was) clears nothing.
  await agentsButton(page).click();
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByRole("button", { name: /^Pip home/ })).toHaveAccessibleName(`Pip home, ${count} things need you`);
  await expect(page.getByRole("button", { name: "Agents", exact: true })).toHaveCount(1);
  // Its card says it is in Needs you, and the pill goes to the need.
  const card = page.locator('main article[data-run-id][data-state="failed"]');
  await expect(card.first().locator("[data-in-needs-you]")).toBeVisible();
  await card.first().locator("[data-in-needs-you]").click();
  await expect(pipHome(page)).toBeVisible();
  await expect(needsPane(page)).toContainText("SUP-9");
  await expect(needsPane(page)).toContainText("Claude asks you once per folder");
  await expect(needsYouCount(page)).toHaveText(String(count));

  // Dismissed, it goes; the run stays in Agents.
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(need(page, /SUP-9/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
  await agentsButton(page).click();
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first().locator("[data-in-needs-you]")).toHaveCount(0);
  // Remembered across a reload.
  await page.reload();
  await expect(agentsButton(page)).toHaveCount(1);
  await openPipHome(page);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
});

test("a run Gossamr stopped at its limit appears in Needs you, with Resume, and leaves once resumed", async ({ page }) => {
  await onHome(page);
  const before = Number(await needsYouCount(page).innerText());
  const run = await runOn(page, "WEB-108");
  expect(await stateOf(page, run.id)).toBe("working");
  await stopRunAtLimit(page, run.id);

  await expect(needsYouCount(page)).toHaveText(String(before + 1));
  await expandGeneral(page);
  const limit = need(page, /WEB-108.*stopped at its limit/);
  await expect(limit).toHaveCount(1);
  await limit.click();
  const pane = needsPane(page);
  await expect(pane).toContainText("was stopped at its limit");
  await expect(pane).toContainText("It stays stopped; its conversation and worktree are kept.");
  await expect(needsPaneHeading(page)).toBeFocused();
  await pane.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => stateOf(page, run.id)).toBe("working");
  await expect(need(page, /WEB-108/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(before));
});

test("a sign-in reads 'needs you to sign in to Claude'; a limit stop is in the list, and an unclear run, a quiet one and a possible continuation are not", async ({ page }) => {
  await onHome(page, "runs=stuck");
  await expandGeneral(page);
  const signed = await runOn(page, "SUP-12");
  await blockRun(page, signed.id);
  const web = await runOn(page, "WEB-108");
  await loseRun(page, web.id);

  await expect(need(page, /SUP-12.*needs you to sign in to Claude/)).toHaveCount(1);
  await expect(need(page, /SUP-12/)).not.toContainText(/permission/i);
  // The sample's stuck runs: a limit stop is a need; the run Gossamr lost track of, the two that may have carried on elsewhere and the run quiet for 40 minutes are states, not needs.
  await expect(need(page, /CA-277.*stopped at its limit/)).toHaveCount(1);
  await expect(need(page, /WEB-108.*can't read/)).toHaveCount(0);
  await expect(need(page, /CA-278/)).toHaveCount(0);
  await expect(need(page, /CA-279/)).toHaveCount(0);
  await expect(need(page, /CA-377/)).toHaveCount(0);

  await need(page, /SUP-12/).click();
  await expect(needsPane(page).getByRole("group", { name: "Sign-in needed" })).toBeVisible();
  await needsPane(page).getByRole("button", { name: "Open in Terminal" }).click();
  await expect.poll(() => mockAttached(page)).toContain(signed.id);
});

test("the keyboard in the list: j and k move, Enter opens, ← folds, a asks for Enter before it approves, d dismisses, Esc goes back", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await holdBySystem(page, "CA-401", "restart");
  await expect(needsYouCount(page)).toHaveText("3");

  const group = needsYouRow(page, "CA-401").locator("[data-needs-you-group]");
  await group.focus();
  // With the keyboard on a row, the footer names the list's own keys.
  const hints = pipHome(page).locator("[data-pip-home-hints]");
  await expect(hints).toContainText("approve or allow (then ↵), edit, dismiss or deny, skip");
  // Enter opens the top need and expands the group; the keyboard is in the decision.
  await page.keyboard.press("Enter");
  await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => focusInPane(page)).toBe(true);
  // Esc is back to the list, on the row it came from.
  await page.keyboard.press("Escape");
  await expect(needsPane(page)).toHaveCount(0);
  await expect(group).toBeFocused();

  // j walks the open group row by row: its own row is its top need's, so the next stop is the next need, not the same one again.
  // ← folds the group again, and the keyboard is on its row.
  await page.keyboard.press("j");
  await expect(need(page, /Draft comment/).first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(need(page, /Draft comment/).nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(need(page, /Draft comment/).first()).toBeFocused();
  await page.keyboard.press("k");
  await expect(group).toBeFocused();
  await page.keyboard.press("j");
  await expect(need(page, /Draft comment/).first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(group).toBeFocused();

  // → opens too. a on a draft asks for Enter, and any other key cancels it; d skips at once.
  await page.keyboard.press("ArrowRight");
  await expect(needsPane(page)).toBeVisible();
  await page.keyboard.press("Escape");
  // The keyboard comes back to the group's row a frame after the pane closes: j before then has nowhere to go.
  await expect(needsPane(page)).toHaveCount(0);
  await expect(group).toBeFocused();
  await page.keyboard.press("j");
  const first = need(page, /Draft comment/).first();
  await expect(first).toBeFocused();
  await page.keyboard.press("a");
  await expect(first.locator("[data-needs-asking]")).toHaveText("↵ approve this draft · any other key cancels");
  await page.keyboard.press("x");
  await expect(first.locator("[data-needs-asking]")).toHaveCount(0);
  expect(await jiraWrites(page)).toEqual([]);
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  await expect(needsYouCount(page)).toHaveText("2");

  // d skips the next draft at once, with an Undo, and focus is on a row still.
  const next = need(page, /Draft comment/).first();
  await next.focus();
  await page.keyboard.press("d");
  await expect(needsYouCount(page)).toHaveText("1");
  await expect(page.locator("[data-toast]").getByRole("button", { name: "Undo" })).toBeVisible();
  expect((await jiraWrites(page)).length).toBe(1);
  await expect.poll(async () => page.evaluate(() => document.activeElement?.closest("[data-needs-you]") !== null)).toBe(true);
});

test("d on a permission asks for Enter before it denies, and e on a question goes to its answer box", async ({ page }) => {
  await onHome(page, MANAGED);
  await expandGeneral(page);
  const permission = need(page, /DEVOPS-471.*asks to run a command/);
  await permission.focus();
  // The sample's permission is a read-only run's: nothing to allow, so a only opens it; d denies after Enter.
  await page.keyboard.press("d");
  await expect(permission.locator("[data-needs-asking]")).toHaveText("↵ deny it; Claude carries on without it · any other key cancels");
  await page.keyboard.press("Escape");
  await expect(permission.locator("[data-needs-asking]")).toHaveCount(0);
  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect.poll(() => stateOf(page, run.id)).toBe("working");

  // e on the question focuses its answer box.
  const question = need(page, /CA-409.*asks a question/);
  await question.focus();
  await page.keyboard.press("e");
  await expect(needsPane(page).getByRole("textbox", { name: "Your answer" })).toBeFocused();
});
