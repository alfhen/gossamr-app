import { expect, type Page, test } from "@playwright/test";
import {
  agentsButton, agentsHome, allProjects, askPip, askRun, blockRun, boxOf, closePipDrawer, closeWorkstreamSheet,
  commentDraft, draftOpen, expandAllNeeds, expandNeedsYou, expectToast, groupOpen, homeConversation,
  homeConversationRegion, homeSettled, INSTANT_PIP, jiraWrites, keepComments, loseRun, MANUAL_PRS, mockAttached,
  mockRuns, needOfKind, needRow, needsFilter, needsPane, needsPaneHeading, needsStack, needsYouCount, needsYouTray,
  openAgents, openApp, openNeedOfKind, openNeedRow, openRunOf, pauseAtCeiling, pipPane, railButton, runSheet,
  selectWorkstream, startWorkstream, stepRail, VAGUE_TICKET, withNeeds, workstreamGroup, workstreamOnHome,
  workstreamSheet,
} from "./support/app";

// Pull requests are shown only when a test says: the setting the phase's scenarios share.
// GitHub is signed in with a catalog small enough to be watched whole, so the agents' repository is watched, as the
// real app needs before it reads a pull request there or drafts a review of one.
const WITH_REPOS = `${MANUAL_PRS}&mockRepos=12`;

/** The rail's Work button. */
const homeButton = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Work(,|$)/ });

/** An item's line without how long it has waited, which can tick over between two reads. */
const withoutAge = (line: string) => line.replace(/ · (?:now|\d+[mhd])$/, "");

const sheetHint = (page: Page) => runSheet(page).locator("span.truncate").first();

/** Pip home on the sample's own runs, with the permission need's decision open in the pane. */
async function onPermission(page: Page) {
  await openApp(page);
  await openAgents(page);
  await expect(needsYouTray(page)).toBeVisible();
  await expandNeedsYou(page, "General");
  const run = (await mockRuns(page)).find((r) => r.key === "DEVOPS-471")!;
  await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
  const pane = needsPane(page);
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  return { run, pane };
}

/** Pip home's composer footer, which says how many need the person. */
const footer = (page: Page) => homeConversationRegion(page).locator("[data-composer-footer]");

const need = needRow;

const chip = (page: Page, name: string) => agentsHome(page).locator(`[data-chip="${name}"]`);

/** The sample's run on ticket `key` (the first, when it has several). */
const runOn = async (page: Page, key: string) => (await mockRuns(page)).find((r) => r.key === key)!;

const stateOf = async (page: Page, id: string) => (await mockRuns(page)).find((r) => r.id === id)?.state;

/** The button that opens or hides the need reading `name` in the open detail. */
const needButton = (page: Page, name: RegExp) => workstreamSheet(page).locator("[data-needs-pane]").filter({ hasText: name }).locator("button[data-need-key]");

/** Whether the keyboard is inside the open decision. */
const focusInPane = (page: Page) => page.evaluate(() => !!document.querySelector("[data-needs-pane][data-open]")?.contains(document.activeElement));

/** Pip home with the sample's own runs (a permission, a question, a failure to retry and a quiet run, all in General), ready. */
async function onHome(page: Page, query = "") {
  await openApp(page, query);
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  await expect(needsYouTray(page)).toBeVisible();
}

const expandGeneral = (page: Page) => expandNeedsYou(page, "General");

const home = (page: Page) => agentsHome(page);

/** A workstream on CA-401 with two drafted comments of Pip's waiting in Needs you: one group of two needs, which may go together. */
async function twoDrafts(page: Page) {
  await openApp(page, INSTANT_PIP);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await keepComments(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("2");
}

test("the Needs you list ranks a question from Pip ahead of a pause, opens each in the pane, and each leaves once dealt with", async ({ page }) => {
  await openApp(page, WITH_REPOS);
  await workstreamOnHome(page);
  const row = workstreamGroup(page, "CA-401");
  await expect(needsYouCount(page)).toHaveText("0");

  await askPip(page, "ask me which database to use");
  await homeSettled(page);
  // Pip can still be idle just after the click, before its turn starts; a pause then would cancel the turn before it asks.
  // The question's need being there is the sign the turn is done. Pip's scripted turn can take longer than the default wait
  // on a loaded CI runner, so this one wait is given more time; what it checks is unchanged.
  await expect(needsYouCount(page)).toHaveText("1", { timeout: 15_000 });
  await pauseAtCeiling(page, "CA-401");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 2 waiting");
  // One row for the workstream; a question for the person ranks ahead of what is stuck (the pause), however old each is.
  await expandNeedsYou(page, "CA-401");
  const titles = needsStack(page).locator("[data-needs-you-need-title]");
  await expect(titles).toHaveText(["Pip asks you", "Paused: Pip was woken too often today"]);

  // From General, the question's need selects the workstream again and opens its decision; dismissed there, it leaves.
  await closeWorkstreamSheet(page);
  await openNeedRow(page, "Pip asks you");
  await expect(needsPane(page)).toContainText("Which database to use?");
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(needRow(page, "Pip asks you")).toHaveCount(0);
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");

  // The pane moved on to the pause, with its heading focused (no key lands on Resume by accident); Resume clears the need and the badge.
  await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
  const resume = needsPane(page).locator("[data-paused-banner]").getByRole("button", { name: "Resume" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await resume.click();
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(row.locator('[data-status="paused"]')).toHaveCount(0);
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

test("a failed run waits in the list under General, opens its decision, and stays until it is dealt with, not just seen", async ({ page }) => {
  await openApp(page, "prSurface=manual");
  await openAgents(page);
  await expandNeedsYou(page);
  // The sample's failed run failed on a folder it may not use yet, so it waits as a failure with a step to take.
  const failed = needRow(page, /SUP-9.*needs its folder trusted/);
  await expect(failed).toHaveCount(1);
  await expect(failed).toHaveAttribute("data-kind", "failure");
  await failed.click();
  await expect(needsPane(page)).toContainText("Trust this folder in Terminal");
  // The run's own card opens its sheet over Agents.
  await openRunOf(page, "SUP-9");
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet.first()).toBeVisible();
  await expect(agentsHome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Agents shows the failure, and showing it clears nothing: back on Pip home it still waits.
  await openAgents(page);
  await expandNeedsYou(page);
  await expect(needRow(page, /SUP-9.*needs its folder trusted/)).toHaveCount(1);
});

test("Needs you: Pip's question waits in the list and on its row, opens its decision, and leaves once dismissed", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await workstreamOnHome(page);
  const row = workstreamGroup(page, "CA-401");
  await expect(row.locator('[data-status="paused"]')).toHaveCount(0);

  await askPip(page, "ask me which database to use");
  await homeSettled(page);
  const item = needOfKind(page, "pipAsk");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Which database to use?");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");

  // From General, the need selects the workstream again and opens its decision, with its own Dismiss.
  await closeWorkstreamSheet(page);
  await expect(homeConversation(page)).toHaveText("General");
  await openNeedOfKind(page, "pipAsk");
  await expect(needsPane(page).locator("[data-pip-ask]")).toHaveText("Which database to use?");

  // Dismissed there, it leaves the list and the badge, and the pane has nothing left to open.
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(item).toHaveCount(0);
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);
  await expect(needsPane(page)).toHaveCount(0);
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

test("Needs you: a pause is a need with Resume as its decision, whether the person made it or the daily ceiling did", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await workstreamOnHome(page);
  const row = workstreamGroup(page, "CA-401");
  const paused = needOfKind(page, "paused");
  await expect(paused).toHaveCount(0);

  await agentsHome(page).getByRole("button", { name: "Pause", exact: true }).click();
  const banner = pipPane(page).locator("[data-paused-banner]");
  await expect(banner).toContainText("Paused. Pip isn't woken until you resume it.");
  await expect(paused).toHaveCount(1);
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");
  await banner.getByRole("button", { name: "Resume" }).click();
  await expect(banner).toHaveCount(0);
  await expect(paused).toHaveCount(0);

  await pauseAtCeiling(page, "CA-401");
  await expect(paused).toHaveCount(1);
  await expect(paused).toContainText("Paused: Pip was woken too often today");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");
  await closeWorkstreamSheet(page);
  await openNeedOfKind(page, "paused");
  const resume = needsPane(page).locator("[data-paused-banner]").getByRole("button", { name: "Resume" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(paused).toHaveCount(0);
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);
});

test("Needs you from the board: the rail's Work popover lists the same rows and opens their decisions on Agents", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await workstreamOnHome(page);
  await askPip(page, "ask me which database to use");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("1", { timeout: 15_000 });
  await pauseAtCeiling(page, "CA-401");
  const total = Number(await needsYouCount(page).innerText());
  expect(total).toBe(2);

  // Back on the board, the Work button counts them, and its menu shows the same list.
  await allProjects(page);
  await expect(agentsHome(page)).toHaveCount(0);
  const button = homeButton(page);
  await expect(button).toHaveAccessibleName(`Work, ${total} things need you`);
  await button.click({ button: "right" });
  const popover = page.getByRole("dialog", { name: "Needs you" });
  await expect(popover.locator("[data-needs-you-count]")).toHaveText(String(total));
  await expect(popover.locator("[data-needs-you-group]")).toHaveCount(1);
  expect((await popover.locator("[data-needs-you-group]").allTextContents()).map(withoutAge)[0]).toContain("Pip asks: “Which database to use?”");

  // Esc closes it and leaves the board as it was.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(agentsHome(page)).toHaveCount(0);

  await button.click({ button: "right" });
  await popover.locator("[data-needs-you-group]").click();
  await expect(popover).toHaveCount(0);
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsPane(page)).toBeVisible();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "pipAsk");
});

test("the rail's batch button approves Pip's two comments and never the description update beside them, which still opens its diff", async ({ page }) => {
  await openApp(page, "runs=empty");
  // Pip's drafts in the workstream's conversation, from the pane beside CA-401's peek: two comments and a description update.
  await startWorkstream(page, "CA-401");
  const pane = pipPane(page);
  for (const [ask, drafts] of [
    ["Draft a comment on this one", 1],
    ["Draft another comment on this one", 2],
    ["Draft a description update", 3],
  ] as const) {
    if (drafts > 1) await keepComments(page);
    await askPip(page, ask);
    await expect(pane.locator('article[data-draft][data-state="pending"]')).toHaveCount(drafts);
  }
  await expect(pane.getByRole("article", { name: "Update the description of CA-401" })).toHaveCount(1);

  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  const section = stepRail(page).getByRole("region", { name: "Pip's drafts" });
  // The description update is a decision, so it is the one open at the top of the detail, and not repeated in the rail.
  const rewrite = needsPane(page).getByRole("article", { name: "Update the description of CA-401" });
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await section.getByRole("button", { name: "Approve 2 of Pip's drafts" }).click();
  await section.getByRole("button", { name: "Yes, approve 2" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await expect(section.getByRole("button", { name: /^Approve \d+ of / })).toHaveCount(0);

  // The update is read in its diff and approved only there.
  await expect(rewrite.getByRole("button", { name: "Approve" }).first()).toBeVisible();
  expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
});

test("a question from Pip waits in Needs you and clears when it is answered in the conversation", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  await askPip(page, "ask me which database to use");
  await homeSettled(page);

  await expect(needsYouCount(page)).toHaveText("1", { timeout: 15_000 });
  await expandNeedsYou(page, "CA-401");
  await expect(needsStack(page).locator("[data-needs-you-need-title]")).toHaveText(["Pip asks you"]);
  await expect(needsStack(page)).toContainText("Which database to use?");

  await askPip(page, "Postgres");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("0");
});

test.describe("answering a question and retrying a run", () => {
  test("an answer from the sheet is confirmed, timed in the timeline, and the sheet keeps its place among the runs", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    // The decision's own link opens the run, with its sheet over Pip home.
    await expandNeedsYou(page);
    await openNeedRow(page, /CA-409.*asks a question/);
    await closeWorkstreamSheet(page);
    await openRunOf(page, "CA-409");
    await expect(runSheet(page)).toBeVisible();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "needsAnswer");
    const place = (await sheetHint(page).textContent())?.match(/(\d+) of (\d+)$/)?.slice(1);
    expect(place).toBeTruthy();
    await runSheet(page).getByRole("textbox", { name: "Your answer" }).fill("Yes, keep the old rounding for refunds.");
    await runSheet(page).getByRole("textbox", { name: "Your answer" }).press("ControlOrMeta+Enter");
    await expectToast(page, "Answer sent. Claude is picking it back up.");
    await expect(runSheet(page).locator("[data-answer-sent]")).toHaveText("Answer sent. Claude is picking it back up.");
    // The answer box had the keyboard; it goes to the line that replaced it, not to the page.
    await expect(runSheet(page).locator("[data-answer-sent]")).toBeFocused();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "working");
    await expect(runSheet(page).getByText("You answered")).toBeVisible();
    await expect(sheetHint(page)).toHaveText(new RegExp(` · run ${place![0]} of ${place![1]}$`));
    // What the run said while it asked is over.
    await expect(runSheet(page)).not.toContainText("Waiting for an answer");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("the answer box starts empty; Claude's suggestion is offered with Use this, and an empty box never sends", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page);
    await openNeedRow(page, /CA-409.*asks a question/);
    const box = needsPane(page).getByRole("textbox", { name: "Your answer" });
    const send = needsPane(page).getByRole("button", { name: "Send answer" });
    await expect(box).toHaveValue("");
    await expect(box).toHaveAttribute("placeholder", /Write your answer/);
    await expect(send).toBeDisabled();
    await expect(needsPane(page).locator("[data-suggested-answer]")).toContainText("Claude suggests: “Yes, keep the old rounding.”");
    await needsPane(page).getByRole("button", { name: "Use this" }).click();
    await expect(box).toHaveValue("Yes, keep the old rounding.");
    await expect(send).toBeEnabled();
    await box.fill("   ");
    await expect(send).toBeDisabled();
    const details = needsPane(page).locator("details", { hasText: "What Gossamr adds" });
    await details.locator("summary").click();
    await expect(details).toContainText("This goes in front of your answer: Reminder:");
    expect((await mockRuns(page)).find((r) => r.state === "needsAnswer")).toBeTruthy();
  });

  test("copying the own-terminal command by hand, selected, enables Retry as the Copy button does", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await openAgents(page);
    // The sheet is where a failed run's command is shown to copy; the decision's link opens it.
    await expandNeedsYou(page);
    await openNeedRow(page, /SUP-9.*needs its folder trusted/);
    await closeWorkstreamSheet(page);
    await openRunOf(page, "SUP-9");
    const retry = runSheet(page).getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeDisabled();
    // Select the command's text and copy it with the keyboard; the Copy button is never pressed.
    const command = runSheet(page).getByRole("button", { name: "Copy the command" }).locator("xpath=preceding-sibling::code");
    await expect(command).toBeVisible();
    await command.selectText();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(retry).toBeEnabled();
    await expect(runSheet(page).getByRole("button", { name: "Copy the command" })).toHaveText("Copy");
  });
});

test.describe("a batch with two identical comments", () => {
  test("covers a comment and its copy once, says which it left out, and posts nothing until the confirm", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty&prSurface=manual&pipPace=1");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // Pip words a check-in three ways, so the fourth asked for says what the first did.
    for (let i = 0; i < 4; i++) {
      if (i > 0) await keepComments(page);
      await askPip(page, "Draft a comment");
      await homeSettled(page);
    }
    await expect(needsYouCount(page)).toHaveText("4");
    await expandNeedsYou(page, "CA-401");
    const ws = needsStack(page);
    await expect(ws.getByRole("button", { name: "Approve 4 safe drafts" })).toHaveCount(0);
    await ws.getByRole("button", { name: "Approve 3 safe drafts" }).click();
    const pane = needsPane(page);
    await expect(pane.locator("[data-needs-you-batch-preview] li")).toHaveCount(3);
    await expect(pane.locator("[data-batch-left-out]")).toContainText("Same text as the comment above, left out");
    expect(await jiraWrites(page)).toEqual([]);
    await pane.getByRole("button", { name: "Yes, approve 3" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment", "comment"]);
    // The copy is still there, to be decided on its own.
    await expect(needsYouCount(page)).toHaveText("1");
  });
});

test.describe("a quiet run", () => {
  test("is not in Needs you, so there is nothing to keep waiting on", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openAgents(page);
    await expect(needsYouTray(page)).toBeVisible();
    await expandNeedsYou(page, "General");
    await expect(needRow(page, /CA-377/)).toHaveCount(0);
  });
});

test.describe("a typed answer to an agent's question", () => {
  test("is not carried over to a new question the run asks while its box is open", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page);
    await openNeedRow(page, /CA-409.*asks a question/);
    const box = needsPane(page).getByRole("textbox", { name: "Your answer" });
    await box.fill("Yes, keep the old rounding.");
    const run = (await mockRuns(page)).find((r) => r.key === "CA-409" && r.state === "needsAnswer");
    expect(run).toBeTruthy();
    await askRun(page, run!.id, "Which currency should refunds use?");
    await expect(needsPane(page)).toContainText("Which currency should refunds use?");
    await expect(box).toHaveValue("");
  });
});

test.describe("Needs you rows", () => {
  test("Needs you rows for tickets outside the watched projects still read KEY · Title", async ({ page }) => {
    await openApp(page, "runs=failures");
    await openAgents(page);
    await expandNeedsYou(page);
    const heads = needsStack(page).locator('[data-needs-pane][data-kind="failure"], [data-needs-pane][data-kind="permission"]').locator("[data-needs-pane-head]");
    await expect(heads.first()).toBeVisible();
    const texts = await heads.allTextContents();
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(t).toMatch(/^[A-Z]+-\d+ · \S/);
    expect(texts).toContain("SUP-9 · Export timeout");
  });
});

test.describe("a folder to trust keeps waiting on the person", () => {
  test("opening Agents leaves it in Needs you and in the one count, on the rail and in the Agents header alike", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const count = await needsYouCount(page).innerText();
    await railButton(page, /^Work/).click();
    await expect(needsYouCount(page)).toHaveText(count);
    // The rail's Work badge is the one count.
    await expect(railButton(page, /^Work/)).toHaveAccessibleName(`Work, ${count} things need you`);
    // Back on Pip home, the folder to trust is still a need, and the count has not moved.
    await openAgents(page);
    await expect(needsYouCount(page)).toHaveText(count);
    await expandNeedsYou(page);
    await expect(needRow(page, /needs its folder trusted/)).toHaveCount(1);
  });
});

test.describe("Needs you titles", () => {
  test("a need's title may take two lines instead of truncating, and the header stays in view", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    const title = needsStack(page).locator("[data-needs-you-need-title]").first();
    await expect(title).toBeVisible();
    expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
    expect(await title.getAttribute("title")).toBeTruthy();
  });
});

test.describe("a need in no workstream", () => {
  test("a need in no workstream has no link to a workstream", async ({ page }) => {
    const { pane } = await onPermission(page);
    await expect(pane.getByRole("button", { name: "Open in workstream" })).toHaveCount(0);
  });
});

test.describe("Needs you for no workstream", () => {
  test("opens No workstream's detail with every need listed once, the first one open, each with a chip that says what it means", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await groupOpen(page, "General").click();
    const items = needsStack(page).locator("[data-needs-pane]");
    await expect(items.nth(1)).toBeVisible();
    await expect(items.first()).toHaveAttribute("data-open", "true");
    await expect(needsPane(page)).toHaveCount(1);
    await expect(needsStack(page).locator("[data-needs-you-chip]").first()).toHaveAttribute("title", /^(Decide|Unblock|Approve): /);
  });
});

test.describe("the permission panel", () => {
  test("shows the command and one way to answer it: Open in Terminal, said in one sentence", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page, "General");
    await openNeedRow(page, /DEVOPS-471.*asks to run a command/);
    const pane = needsPane(page);
    const ask = pane.locator("[data-permission-ask]");
    await expect(ask).toContainText("git push origin HEAD");
    await expect(ask).toContainText("you answer it in Terminal");
    await expect(ask.getByRole("button")).toHaveText(["Copy", "Open in Terminal"]);
    await expect(pane.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await ask.getByRole("button", { name: "Open in Terminal" }).click();
    await expect.poll(async () => (await mockAttached(page)).length).toBe(1);
  });
});

test.describe("approving a plan from its decision", () => {
  test("'Update description' on the plan's decision approves it: the draft leaves, Needs you drops by one, Jira gets the edit", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await workstreamOnHome(page);
    const before = Number(await needsYouCount(page).innerText());
    expect(before).toBeGreaterThan(0);
    await openNeedOfKind(page, "plan");
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toContain("rewrite");
    await expect(needOfKind(page, "plan")).toHaveCount(0);
    // The plan is no longer a need.
    expect(Number(await needsYouCount(page).innerText())).toBeLessThanOrEqual(before);
    await expect(agentsHome(page)).toBeVisible();
  });
});

test.describe("the decision pane's Done line", () => {
  test("says a posted comment was posted to Jira, and names the next need's ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await openNeedRow(page, /Pip drafted a comment/);
    await pauseAtCeiling(page, "CA-401");
    await expect(needsStack(page)).toContainText("Paused: Pip was woken too often today");
    await needsPane(page).getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Paused: Pip was woken too often today$/);
  });
});

test.describe("the Needs you list on Work", () => {
  test("opens a workstream with its needs at the top of the detail, most urgent first, the first one open", async ({ page }) => {
    await withNeeds(page);
    await groupOpen(page, "CA-401").click();
    const sheet = workstreamSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Needs you" })).toBeVisible();
    const items = needsStack(page).locator("[data-needs-pane]");
    expect(await items.count()).toBeGreaterThan(1);
    // A decision (the plan) outranks what is stuck (the pause).
    await expect(items.first()).toHaveAttribute("data-group", "decide");
    await expect(items.first()).toHaveAttribute("data-open", "true");
    await expect(items.nth(1)).toHaveAttribute("data-kind", "paused");
    await items.nth(1).locator("[data-need-key]").click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
    await expect(items.first()).not.toHaveAttribute("data-open", "true");
  });

  test("lists a need that belongs to no workstream under No workstream, reachable with the filter on", async ({ page }) => {
    await withNeeds(page);
    await needsFilter(page).click();
    const none = agentsHome(page).locator('[data-workstream-group="none"]');
    await expect(none.locator("[data-needs-you-badge]")).toBeVisible();
    await groupOpen(page, "General").click();
    await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
    await expect(needsStack(page).locator("[data-needs-pane]").first()).toHaveAttribute("data-open", "true");
  });

  test("lists a failed agent, a Pip question and a pending draft under the Needs you filter", async ({ page }) => {
    await openApp(page, "runs=failures&prSurface=manual");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // The question last: Pip's next message would answer it.
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await askPip(page, "ask me which database to use");
    await homeSettled(page);
    await closePipDrawer(page);
    await needsFilter(page).click();
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "true");

    await expect(workstreamGroup(page, "CA-401")).toBeVisible();
    await expandNeedsYou(page, "CA-401");
    await expect(needOfKind(page, "pipAsk")).toContainText("Which database to use?");
    await expect(needRow(page, /Draft comment/)).toHaveCount(1);

    await expandNeedsYou(page, "General");
    await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
    await expect(needOfKind(page, "failure")).toBeVisible();
  });

  test("opens from the rail's Needs you popover with the filter on and that need open", async ({ page }) => {
    await withNeeds(page);
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "false");
    await openNeedOfKind(page, "paused");
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "true");
    await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
    await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
  });
});

test("a workstream's needs are one stack at the top of its detail, most urgent first, and one count on the rail, the chip and under the composer", async ({ page }) => {
  await openApp(page);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  // The sample leaves CA-401's plan to approve; the workstream gets a pause (the ceiling's) and a draft of Pip's: three needs, one stack.
  await pauseAtCeiling(page, "CA-401");
  await askPip(page, "Draft a comment");
  await homeSettled(page);

  const items = needsStack(page).locator("[data-needs-pane]");
  await expect(items).toHaveCount(3);
  await expect(needsStack(page).locator("[data-workstream-needs-count]")).toHaveText("3");
  // The plan is a decision, which ranks above what is stuck and what waits for an approval.
  await expect(items.nth(0)).toContainText("Approve the plan");
  await expect(items.nth(0)).toContainText("approving its description update is how the plan is approved");
  await expect(items.nth(0).locator("[data-needs-you-chip]")).toHaveText("Decide");
  await expect(items.nth(1)).toContainText("Paused: Pip was woken too often today");
  await expect(items.nth(2)).toContainText("Draft comment");
  // Only one is open at a time: the first, until another is chosen.
  await expect(items.nth(0)).toHaveAttribute("data-open", "true");
  await expect(needsPane(page)).toHaveCount(1);
  await needButton(page, /Paused: Pip was woken too often today/).click();
  await expect(items.nth(1)).toHaveAttribute("data-open", "true");
  await expect(needsPane(page)).toHaveCount(1);

  // General's three (a permission, a question and a failure; a run gone quiet is no need) are one stack too.
  await groupOpen(page, "General").click();
  await expect(needsStack(page).locator("[data-needs-pane]")).toHaveCount(3);

  // The one count: the chip, the rail's badge and the composer say the same six.
  await expect(needsYouCount(page)).toHaveText("6");
  await expect(homeButton(page)).toHaveAccessibleName("Work, 6 things need you");
  await expect(homeButton(page).locator('[aria-label="6 things need you"]')).toHaveText("6");
  await expect(footer(page)).toHaveText(/ · 6 need you$/);
  await expect(workstreamGroup(page, "CA-401").locator("[data-status]")).toHaveText("Needs you");
  await expect(workstreamGroup(page, "CA-401").locator("[data-status-detail]")).toHaveText("· 3 waiting");
});

test("deciding a permission from the pane: Open in Terminal opens the run there, and the need waits for the person's answer in Terminal", async ({ page }) => {
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
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Deny" })).toHaveCount(0);

  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await pane.locator("[data-permission-ask]").getByRole("button", { name: "Open in Terminal" }).click();
  await expect.poll(() => mockAttached(page)).toContain(run.id);
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await expect(needsYouCount(page)).toHaveText(before);
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
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await pauseAtCeiling(page, "CA-401");
  await expect(needsYouCount(page)).toHaveText("2");

  await expect(needsStack(page).locator("[data-needs-pane]").first()).toBeVisible();
  await need(page, /Draft comment/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("drafted a comment on CA-401.");
  await expect(pane).toContainText("It stays here until you decide.");
  await expect(pane.locator("article[data-draft]")).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);

  // Esc hides the decision and leaves the keyboard on the need's own button.
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(needButton(page, /Draft comment/)).toBeFocused();

  await need(page, /Draft comment/).click();
  await pane.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  await expect(need(page, /Draft comment/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText("1");
  // The pause is next: its decision opens in the pane, with Resume.
  await expect(pane).toHaveAttribute("data-kind", "paused");
  await expect(pane.locator("[data-paused-banner]").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect.poll(() => focusInPane(page)).toBe(true);
  await pane.getByRole("button", { name: "Resume" }).click();
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
  await expect(pane).toHaveCount(0);
  await expect(needsStack(page)).toHaveCount(0);
  await expect(homeButton(page)).toHaveAccessibleName("Work");
  await expect(footer(page)).toHaveText(/nothing needs you$/);
});

test("'Approve N safe drafts' approves comments and moves together after one confirm, with what each does shown first", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "move it to QA");
  await homeSettled(page);
  await keepComments(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("3");

  // The detail offers the batch with the number, above its needs.
  const batch = needsStack(page).getByRole("button", { name: "Approve 3 safe drafts" });
  await batch.click();
  // The preview opens above the needs like any other decision.
  const pane = needsPane(page);
  await expect(pane).toHaveAttribute("data-kind", "batch");
  const preview = pane.locator("[data-needs-you-batch-preview] li");
  await expect(preview).toHaveCount(3);
  await expect(preview.first()).toContainText(/Comment on CA-401|Move CA-401/);
  expect(await jiraWrites(page)).toEqual([]);

  // Cancel keeps them all, and closes the preview.
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
  await closeWorkstreamSheet(page);
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator("[data-rail]").getByRole("button", { name: /^Work(,|$)/ })).toHaveAccessibleName(`Work, ${count} things need you`);
  // Its card says it is in Needs you, and the pill goes to the need.
  const card = page.locator('main article[data-run-id][data-state="failed"]');
  await expect(card.first().locator("[data-in-needs-you]")).toBeVisible();
  await card.first().locator("[data-in-needs-you]").click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsPane(page)).toContainText("SUP-9");
  await expect(needsPane(page)).toContainText("Claude asks you once per folder");
  await expect(needsYouCount(page)).toHaveText(String(count));

  // Dismissed, it goes; the run stays in Agents.
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(need(page, /SUP-9/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
  await chip(page, "needs").click();
  await closeWorkstreamSheet(page);
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first().locator("[data-in-needs-you]")).toHaveCount(0);
  // Remembered across a reload.
  await page.reload();
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
});

test("a sign-in reads 'needs you to sign in to Claude'; an unclear run, a quiet one and a possible continuation are not in the list", async ({ page }) => {
  await onHome(page, "runs=stuck");
  await expandGeneral(page);
  const signed = await runOn(page, "SUP-12");
  await blockRun(page, signed.id);
  const web = await runOn(page, "WEB-108");
  await loseRun(page, web.id);

  await expect(need(page, /SUP-12.*needs you to sign in to Claude/)).toHaveCount(1);
  await expect(need(page, /SUP-12/)).not.toContainText(/permission/i);
  // The sample's stuck runs: the run Gossamr lost track of, the two that may have carried on elsewhere and the run quiet for 40 minutes are states, not needs.
  await expect(need(page, /WEB-108.*can't read/)).toHaveCount(0);
  await expect(need(page, /CA-278/)).toHaveCount(0);
  await expect(need(page, /CA-279/)).toHaveCount(0);
  await expect(need(page, /CA-377/)).toHaveCount(0);

  await need(page, /SUP-12/).click();
  await expect(needsPane(page).getByRole("group", { name: "Sign-in needed" })).toBeVisible();
  await needsPane(page).getByRole("button", { name: "Open in Terminal" }).click();
  await expect.poll(() => mockAttached(page)).toContain(signed.id);
});

test("a permission has no key to deny it, and e goes to the answer box of a question", async ({ page }) => {
  await onHome(page);
  const card = (key: string) => agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();
  const permission = card("DEVOPS-471");
  await permission.focus();
  // A permission is answered in Terminal: d asks for nothing and changes nothing.
  await page.keyboard.press("d");
  await expect(permission.locator("[data-needs-asking]")).toHaveCount(0);
  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");

  // e on the question opens its decision with the answer box focused.
  const question = card("CA-409");
  await question.focus();
  await page.keyboard.press("e");
  await expect(needsPane(page).getByRole("textbox", { name: "Your answer" })).toBeFocused();
});

test.describe("a decision shows once", () => {
  test("the pane is the only scroller in its place, and the draft's action bar is in the flow, never over the text", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual");
    await openAgents(page);
    await groupOpen(page, "General").click();
    const pane = needsPane(page);
    const bar = pane.locator("[data-draft-actions]").first();
    await expect(bar).toBeVisible();
    // Long enough to scroll, and scrolled to the middle: a sticky bar would sit over the draft's text.
    await pane.evaluate((el) => (el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)));
    const overlaps = await pane.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>("[data-draft-actions]")!;
      const before = actions.previousElementSibling as HTMLElement | null;
      return { position: getComputedStyle(actions).position, gap: before ? actions.getBoundingClientRect().top - before.getBoundingClientRect().bottom : 0 };
    });
    expect(overlaps.position).toBe("static");
    expect(overlaps.gap).toBeGreaterThanOrEqual(-1);
    // No scroller inside the pane but the pane, bar a long diff, which scrolls in a box of its own so the bar under it stays in view.
    const nested = await pane.evaluate((el) => Array.from(el.querySelectorAll("*")).filter((e) => !e.matches("[data-diff]") && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length);
    expect(nested).toBe(0);
    // The last of the draft is reachable above its bar: scrolled to the end, the bar is the pane's last line.
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const [p, b] = [await boxOf(pane), await boxOf(bar)];
    expect(b.y + b.height).toBeLessThanOrEqual(p.y + p.height + 1);
  });

  test("a pause is the pane's banner alone, not the rail's as well", async ({ page }) => {
    await openApp(page, "runs=empty");
    await workstreamOnHome(page);
    // The sheet holds both: the rail's banner is the one outside the Needs you section.
    const railBanner = stepRail(page).locator("[data-paused-banner]:not([data-needs-pane] *)");
    await pauseAtCeiling(page, "CA-401");
    await expect(home(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(railBanner).toHaveCount(1);
    await openNeedOfKind(page, "paused");
    await expect(needsPane(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(home(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(railBanner).toHaveCount(0);
    // Closed, the rail shows it again.
    await page.keyboard.press("Escape");
    await expect(railBanner).toHaveCount(1);
  });
});

test.describe("one label for approving drafts together, and its preview opens in the decision pane", () => {
  test("'Approve N safe drafts' opens the preview and its one confirm in the pane, not inside the list; Cancel and Esc keep the drafts", async ({ page }) => {
    await twoDrafts(page);
    await expandNeedsYou(page, "CA-401");
    const batch = needsStack(page).getByRole("button", { name: "Approve 2 safe drafts" });
    await expect(batch).toHaveCount(1);
    await expect(agentsHome(page).getByRole("button", { name: /^Approve these/ })).toHaveCount(0);
    await batch.click();

    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await expect(pane.locator("[data-needs-pane-title]")).toHaveText("Approve 2 safe drafts");
    await expect(pane).toContainText("They stay here until you decide.");
    await expect(pane.locator("[data-needs-you-batch-preview] li")).toHaveCount(2);
    await expect(needsYouTray(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Yes, approve 2" })).toBeFocused();
    expect(await jiraWrites(page)).toEqual([]);

    // Esc from the confirm keeps every draft, closes the pane and returns to the row.
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    await expect(needsYouCount(page)).toHaveText("2");
    await expect(needsStack(page).locator("[data-workstream-needs-title]")).toBeFocused();

    // Choosing a need's own row replaces the preview with its decision.
    await batch.click();
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await needRow(page, /Draft comment/).first().click();
    await expect(needsPane(page)).not.toHaveAttribute("data-kind", "batch");
    await expect(needsPane(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);

    // The palette's entry opens the same pane, and the confirm approves exactly the two it showed.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("approve all safe");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: /Approve all safe drafts in CA-401/ }).click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "batch");
    await needsPane(page).getByRole("button", { name: "Yes, approve 2" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsPane(page).locator("[data-batch-outcome]")).toContainText("Approved 2");
  });
});

test.describe("posting the last need", () => {
  test("posting the only need from the pane says what was posted", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Approve" }).click();
    await expectToast(page, "Posted to Jira: Draft comment: “Checking in on this one. Is…” on CA-408.");
  });
});

test("a need that ranks higher and comes in later is listed above the open one, and nothing switches under the person", async ({ page }) => {
  await draftOpen(page);
  await pauseAtCeiling(page, "CA-401");
  const kinds = needsStack(page).locator("[data-needs-pane]");
  await expect.poll(async () => (await kinds.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).filter((k) => k === "paused" || k === "draft")).toEqual(["paused", "draft"]);
  // The decision that was open stays open.
  await expect(needsPane(page)).toHaveAttribute("data-kind", "draft");
});

test("when the pane moves on by itself it says so for a few seconds, and the new pane's heading has the keyboard", async ({ page }) => {
  await draftOpen(page);
  await pauseAtCeiling(page, "CA-401");
  await expect(needsStack(page)).toContainText("Paused: Pip was woken too often today");
  const pane = needsPane(page);
  await pane.getByRole("button", { name: "Approve" }).click();
  await expect(pane).toHaveAttribute("data-kind", "paused");
  const line = page.locator("[data-needs-advanced]");
  await expect(line).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Paused: Pip was woken too often today$/);
  await expect(needsPaneHeading(page)).toBeFocused();
  // Not a stop for the keyboard, and it goes by itself.
  await expect(line).toHaveAttribute("role", "status");
  await expect(line).toHaveCount(0, { timeout: 9000 });
  await expect(needsYouCount(page)).toHaveText("1");
});

test.describe("opening a need", () => {
  test("always lands on the pane's heading, whatever the kind of need", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, INSTANT_PIP);
    await startWorkstream(page, VAGUE_TICKET);
    await openAgents(page);
    await selectWorkstream(page, VAGUE_TICKET);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await pauseAtCeiling(page, VAGUE_TICKET);
    for (const kind of ["paused", "draft"]) {
      await openNeedOfKind(page, kind);
      await expect(needsPane(page)).toBeVisible();
      await expect(needsPaneHeading(page)).toBeFocused();
      await expect(needsPaneHeading(page)).toHaveAttribute("role", "heading");
      await page.keyboard.press("Escape");
      await expect(needsPane(page)).toHaveCount(0);
    }
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
