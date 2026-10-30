import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  agentsHome, allProjects, ask, askPip, commentDraft, draftOn, expandAllNeeds, expandNeedsYou, finishOnHome, homeComposer,
  homeConversation, homeConversationRegion, homeSettled, jiraWrites, keepComments, MANUAL_PRS, needRow, needsPane,
  needsStack, needsYouCount, needsYouRow, needsYouTray, openAgents, openApp, openNeedRow, openPip, paneSettled,
  peekSheet, peekTicket, PIP_INPUT, pipCommentDraft, pipPane, reviewedDraft, selectWorkstream, startWorkstream, toast,
} from "./support/app";
import { newest } from "./support/steps";

/** Opens CA-401's peek. */
async function peekCa401(page: Page) {
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
}

/** Where a box is on the page. */
const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Pip's and the person's move drafts of CA-401 in Pip home's conversation, as cards still open or decided. */
const moveCards = (page: Page) => homeConversationRegion(page).getByRole("article", { name: "Move CA-401", exact: true });

// The comment the sample Pip drafts when asked for one on the open ticket (scriptPip in src/backend/mockPip.ts).
const NUDGE = "Checking in on this one. Is it still on track, or does anything need to move?";

const card = (page: Page, name: string) => pipPane(page).getByRole("article", { name });

const stateOf = (article: ReturnType<typeof card>) => article.locator("div").first().locator("span").last();

/** Opens CA-401's peek, so Pip's drafts land on it, and then Pip. */
async function onCa401(page: Page) {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await openPip(page);
}

/** Asks the sample Pip for a comment on the open ticket and waits for the new draft card. */
async function askForComment(page: Page) {
  const before = await card(page, "Comment on CA-401").count();
  if (before > 0) await keepComments(page);
  await askPip(page, "Draft a comment");
  await expect(card(page, "Comment on CA-401")).toHaveCount(before + 1);
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Whether the card draws a focus ring a person can see. */
const ring = (article: ReturnType<typeof card>) => article.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));

/** Whether the card's last line, its key hint, is cut off by the conversation's scroll box. */
const hintClipped = (article: ReturnType<typeof card>) =>
  article.evaluate((el) => {
    const hint = el.lastElementChild!.getBoundingClientRect();
    const box = el.closest(".overflow-auto")!.getBoundingClientRect();
    return hint.bottom > box.bottom + 1 || hint.top < box.top - 1;
  });

test("a draft a run left shows it was drafted by an agent and can still be approved", async ({ page }) => {
  await openApp(page);
  await peekCa401(page);
  // The description update CA-401's done Plan run left (seedPlanDescriptions in src/backend/mockRuns.ts).
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await expect(draft).toBeVisible();
  const badge = draft.locator('[data-created-by="agent"]');
  await expect(badge).toHaveText("Drafted by an agent");
  // Named by ticket and step, never by the run's id, and the name opens the run.
  const from = draft.locator("[data-provenance=run]");
  await expect(from).toContainText("From the CA-401 plan");
  await expect(from).not.toContainText(/\b[0-9a-f]{8}\b/);
  await expect(draft.getByRole("button", { name: "Approve" })).toBeEnabled();
  await from.getByRole("button", { name: "the CA-401 plan" }).click();
  await expect(page.getByRole("dialog", { name: "Agent run" })).toBeVisible();
});

test.describe("draft cards in the Pip pane", () => {
  /** Two comment drafts on CA-401 in the pane, with the peek closed again. */
  async function twoComments(page: Page) {
    await openApp(page);
    await peekTicket(page, "CA-401");
    await openPip(page);
    for (let i = 1; i <= 2; i++) {
      if (i > 1) await keepComments(page);
      await askPip(page, "Draft a comment");
      await expect(pipPane(page).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(i);
      await paneSettled(page);
    }
    await peekSheet(page).getByRole("button", { name: "Close details" }).click();
    await expect(peekSheet(page)).toHaveCount(0);
    return pipPane(page).getByRole("article", { name: "Comment on CA-401" });
  }

  test("one click on a draft card's 'Review on KEY →' opens the peek, and a card's key hint never changes its height", async ({ page }) => {
    const cards = await twoComments(page);
    // Arm the older card from the keyboard: ArrowUp from the empty input, then up once more.
    await page.locator(PIP_INPUT).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const armed = cards.first();
    await expect(armed).toBeFocused();
    const hint = armed.locator("[data-key-hint]");
    await expect(hint).toHaveText("a approve · e edit · d s skip · ↵ open");
    // The hint hangs under the card: the card is as tall with it as without it.
    const tall = (await armed.boundingBox())!.height;
    await page.locator(PIP_INPUT).focus();
    await expect(hint).toHaveCount(0);
    expect((await armed.boundingBox())!.height).toBe(tall);
    // From an armed card, one click on the next card's button opens the peek.
    await page.locator(PIP_INPUT).press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(armed.locator("[data-key-hint]")).toBeVisible();
    await cards.last().getByRole("button", { name: "Review on CA-401 →" }).click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  });

  test("an armed card's key hint hangs clear of the next card's title, in the Drafts waiting list where cards sit closest", async ({ page }) => {
    await openApp(page, MANUAL_PRS);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "investigate this");
    await homeSettled(page);
    await finishOnHome(page, (await newest(page, "investigate"))!.id);
    await keepComments(page);
    await askPip(page, "triage this");
    await homeSettled(page);
    await finishOnHome(page, (await newest(page, "triage"))!.id);
    // The wakes' drafts wait on the timeline, one under the other.
    const waiting = homeConversationRegion(page).locator('[data-timeline] article[data-draft][data-state="pending"]');
    await expect(waiting.nth(1)).toBeVisible();
    const first = waiting.first();
    await page.locator(PIP_INPUT).focus();
    // ArrowUp walks the timeline's entries, the runs and Pip's turns between the cards included.
    for (let i = 0; i < 16 && !(await first.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    const hint = first.locator("[data-key-hint]");
    await expect(hint).toBeVisible();
    const under = (await hint.boundingBox())!;
    const title = (await waiting.nth(1).locator("[data-draft-body] > div").first().boundingBox())!;
    expect(under.y + under.height).toBeLessThanOrEqual(title.y);
  });
});

test.describe("a long description draft", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("scrolls its diff in a box of its own, so Edit, Skip and Update description are in view on open", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=kinds");
    await openAgents(page);
    await expandAllNeeds(page);
    await openNeedRow(page, /Approve the plan/);
    const pane = needsPane(page);
    const draft = pane.getByRole("article", { name: /Update the description of CA-401/ });
    await expect(draft).toBeVisible();
    // Make the diff long: the pane's cap is what keeps the bar near it, so the draft is edited to be much longer than the cap.
    await draft.getByRole("button", { name: "Edit" }).click();
    const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long description.`).join("\n");
    await body.fill(`${await body.inputValue()}\n\n${lines}`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    const diff = draft.locator('[data-diff="description"]');
    expect(await diff.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(draft.locator("[data-diff-more]")).toContainText("Scroll for the whole diff");
    // The action bar is still in the flow, not sticky over the text, and sits right under the capped diff.
    const bar = draft.locator("[data-draft-actions]");
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    const paneBox = await box(pane);
    const update = await box(draft.getByRole("button", { name: "Approve" }));
    expect(update.y).toBeGreaterThanOrEqual(paneBox.y);
    expect(update.y + update.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
    expect(update.y + update.height).toBeLessThanOrEqual(900);
    // Scrolling the diff to its end takes the hint away.
    await diff.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(draft.locator("[data-diff-more]")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("a skipped comment draft", () => {
  test("Undo after Skip takes the Done line away", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(page.locator("[data-toast]").getByRole("button", { name: "Undo" })).toBeVisible();
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveCount(0);
  });
});

test.describe("a comment draft for keyboard and screen reader users", () => {
  test("takes the keyboard on its card, names its edit field and keeps the toast's live region to its message", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    // In the decision that shows it, not on the Manage switch, which Space would flip.
    await expect(needsPane(page).locator(":focus")).toHaveCount(1);
    await expect(page.locator('[role="switch"]:focus')).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(draft.getByRole("combobox", { name: /Edit the comment on CA-408/ })).toBeVisible();
    await draft.getByRole("button", { name: "Skip" }).click();
    const live = page.locator("[data-toast-status]");
    await expect(live).toHaveAttribute("role", "status");
    const message = (await live.textContent()) ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(await page.locator('[role="status"]:has([data-toast-action])').count()).toBe(0);
    await expect(page.locator("[data-toast]").getByRole("button", { name: /^Undo[^:]*: / })).toBeVisible();
    expect(await page.locator("[data-toast-text]").textContent()).toBe(message);
  });
});

test.describe("the description update's note", () => {
  test("the card says it changes the ticket in Jira as you and that Jira notifies its watchers", async ({ page }) => {
    await openApp(page);
    await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
    const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
    await expect(draft.locator("[data-rewrite-note]")).toHaveText("Changes the ticket's description in Jira as you; Jira notifies its watchers.");
  });
});

test.describe("an edit kept after its card leaves", () => {
  test("an edit finished with Done editing is still on the card after the pane moves away and back, and posting posts it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Kept after the card left.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    // The card leaves: the pane is closed, then the draft is opened again from Needs you.
    await needsPane(page).getByRole("button", { name: "Hide" }).click();
    await expect(draft).toHaveCount(0);
    await needRow(page, /Draft comment/).click();
    await expect(draft).toContainText("Kept after the card left.");
    await draft.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.text)).toEqual([expect.stringContaining("Kept after the card left.")]);
  });
});

test.describe("a skip announces once", () => {
  test("a skip with no other need in the workstream is said by the toast's live region, once", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    await selectWorkstream(page, "CA-402");
    await pipCommentDraft(page, "CA-402");
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveCount(0);
    await expect(page.locator("[data-toast]").getByRole("button", { name: /^Undo/ })).toBeVisible();
    await expect(page.locator("[data-toast-status]")).toContainText("Skipped");
  });
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

test("ArrowUp from the empty input reaches Pip's new comment draft with a visible ring, and a then Enter approves it", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  const input = page.locator(PIP_INPUT);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  const draft = card(page, "Comment on CA-401");

  await input.press("ArrowUp");
  await expect(draft).toBeFocused();
  expect(await ring(draft)).toEqual({ style: "solid", width: "2px" });
  await expect(draft).toContainText("a approve · e edit · d s skip · ↵ open");
  expect(await hintClipped(draft)).toBe(false);
  await page.keyboard.press("a");
  await expect(draft.locator("[data-key-hint]")).toHaveText("↵ approve · any other key cancels");
  expect(await hintClipped(draft)).toBe(false);
  await expect(stateOf(draft)).toHaveText("Draft");
  await page.keyboard.press("Enter");

  await expect(stateOf(draft)).toHaveText("Done");
  await expect(peekSheet(page).locator("#peek-comments").getByText(NUDGE)).toBeVisible();
});

test("text typed after ArrowUp never decides a draft and lands in the input", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  const input = page.locator(PIP_INPUT);
  const draft = card(page, "Comment on CA-401");
  const comments = peekSheet(page).locator("#peek-comments").getByText(NUDGE);

  // As someone who expects ArrowUp to bring back their last question and then types a new one.
  await input.press("ArrowUp");
  await expect(draft).toBeFocused();
  await page.keyboard.type("add a note");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("add a note");

  await input.fill("");
  await input.press("ArrowUp");
  // A question that drafts nothing: "show me the drafts" on an open ticket has the sample Pip draft a second comment,
  // whose card would race this test's own.
  await page.keyboard.type("how is it going");
  await page.keyboard.press("Enter");
  await expect(pipPane(page).getByText("how is it going", { exact: true })).toBeVisible();
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(card(page, "Comment on CA-401")).toHaveCount(1);

  await input.fill("");
  await input.press("ArrowUp");
  await expect(draft).toBeFocused();
  await page.keyboard.type("just checking");
  await expect(input).toHaveValue("just checking");

  await input.fill("");
  await input.press("ArrowUp");
  await page.keyboard.type("okay");
  // Had o opened the ticket, the input would hold "kay" or lose the focus.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("okay");

  await expect(stateOf(draft)).toHaveText("Draft");
  await expect(comments).toHaveCount(0);
});

test("a click on a card's text neither shows its keys nor lets a and Enter approve it", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  const draft = card(page, "Comment on CA-401");

  await draft.getByText(NUDGE).click();
  await expect(draft).toBeFocused();
  await expect(draft.locator("[data-key-hint]")).toHaveCount(0);
  expect((await ring(draft)).style).toBe("none");
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");

  await expect(stateOf(draft)).toHaveText("Draft");
  await expect(peekSheet(page).locator("#peek-comments").getByText(NUDGE)).toHaveCount(0);
});

test("skipping the last card under Drafts waiting hands focus to the input, so j types instead of moving the canvas", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  const waiting = pipPane(page).getByRole("region", { name: "Drafts" });
  const draft = waiting.getByRole("article").last();
  const name = await draft.locator("h3").first().textContent();
  const before = await waiting.getByRole("article").count();

  await page.locator(PIP_INPUT).press("ArrowUp");
  await expect(waiting.getByRole("article", { name: name! })).toBeFocused();
  await page.keyboard.press("s");
  await expect(waiting.getByRole("article", { name: name! })).toHaveCount(0);

  const next = before > 1 ? waiting.getByRole("article").last() : page.locator(PIP_INPUT);
  await expect(next).toBeFocused();
  await page.keyboard.press("j");
  await expect(peekSheet(page)).toHaveCount(0);
  if (before === 1) await expect(page.locator(PIP_INPUT)).toHaveValue("j");
});

test("a second draft reached with the arrows is skipped with s, at once", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  await askForComment(page);
  const [first, second] = [card(page, "Comment on CA-401").nth(0), card(page, "Comment on CA-401").nth(1)];

  await page.locator(PIP_INPUT).press("ArrowUp");
  await expect(second).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await page.keyboard.press("s");

  await expect(stateOf(second)).toHaveText("Skipped");
  await expect(stateOf(first)).toHaveText("Draft");
});

test.describe("draft action bar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const scroller = (page: Page) => peekSheet(page).locator("[data-peek-scroll]");

  /** The action bar of `card`: the row that holds `button`. */
  const barOf = (card: Locator, button: string | RegExp) => card.locator("[data-draft-actions]").filter({ has: card.page().getByRole("button", { name: button, exact: true }) });

  /** The bar is opaque and has a rule above it. */
  async function expectSolid(bar: Locator) {
    const style = await bar.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, top: getComputedStyle(el).borderTopWidth, position: getComputedStyle(el).position }));
    expect(style.position).toBe("sticky");
    expect(style.top).not.toBe("0px");
    const alpha = style.bg.match(/rgba?\(([^)]+)\)/)![1].split(/[ ,/]+/).filter(Boolean)[3];
    expect(alpha === undefined || Number(alpha) === 1).toBe(true);
  }

  /** Scrolls the peek so that `card`'s bottom is in view, and checks the bar sits flush with that bottom. */
  async function expectFlushAtEnd(page: Page, card: Locator, bar: Locator) {
    await card.evaluate((el) => el.scrollIntoView({ block: "end" }));
    await expect.poll(async () => Math.abs((await box(bar)).y + (await box(bar)).height - ((await box(card)).y + (await box(card)).height))).toBeLessThanOrEqual(2);
    const view = await box(scroller(page));
    const b = await box(bar);
    expect(b.y + b.height).toBeLessThanOrEqual(view.y + view.height + 1);
    await expectSolid(bar);
  }

  test("a long description draft's bar sits at the peek's visible bottom, with nothing of the card under it", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-401");
    const card = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
    const bar = barOf(card, "Approve");
    await expect(bar).toBeVisible();
    const view = await box(scroller(page));
    const c = await box(card);
    // The card runs on below the peek's visible bottom, so the bar is held there, not at the card's end.
    expect(c.y + c.height).toBeGreaterThan(view.y + view.height);
    const b = await box(bar);
    expect(Math.abs(b.y + b.height - (view.y + view.height))).toBeLessThanOrEqual(2);
    expect(b.y + b.height).toBeLessThanOrEqual(900);
    // Under the bar is the peek's footer or the window's edge, never more of the draft.
    const under = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { inCard: el?.closest("article[data-draft]")?.querySelector("h3")?.textContent === "Update the description of CA-401", inScroller: !!el?.closest("[data-peek-scroll]") };
    }, { x: b.x + b.width / 2, y: b.y + b.height + 4 });
    expect(under.inCard && under.inScroller).toBe(false);
    await expectSolid(bar);
  });

  test("the GitHub review's Approve bar and the comment draft's Approve bar sit flush with their cards' bottoms", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expectFlushAtEnd(page, review, barOf(review, "Approve"));

    // The review run's own comment draft, and one Pip writes: each is a short card.
    const comments = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
    const before = await comments.count();
    await openPip(page);
    if (before > 0) await keepComments(page);
    await askPip(page, "Draft a comment");
    await expect(comments).toHaveCount(before + 1);
    await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
    for (let i = 0; i <= before; i++) await expectFlushAtEnd(page, comments.nth(i), barOf(comments.nth(i), "Approve"));
  });

  test("a keyboard-focused draft card in the Pip pane shows its whole focus ring", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-401");
    await openPip(page);
    for (let i = 0; i < 3; i++) {
      if (i > 0) await keepComments(page);
      await askPip(page, "Draft a comment");
      await expect(pipPane(page).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(i + 1);
      await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
    }
    const cards = pipPane(page).getByRole("article", { name: "Comment on CA-401" });
    const conversation = pipPane(page).locator("[data-pip-conversation-body]");

    /** The focused card with its 2px ring 2px out lies inside the conversation's scroll box. */
    const expectWhole = async (card: Locator) => {
      await expect(card).toBeFocused();
      const ring = 4;
      const c = await box(card);
      const s = await box(conversation);
      expect(c.y - ring).toBeGreaterThanOrEqual(s.y - 0.5);
      expect(c.y + c.height + ring).toBeLessThanOrEqual(s.y + s.height + 0.5);
    };

    await page.locator(PIP_INPUT).press("ArrowUp");
    await expectWhole(cards.last());
    // Just reached from the input, a letter goes back there as typing, so the first step is an arrow.
    await page.keyboard.press("ArrowUp");
    await expectWhole(cards.nth(1));
    await page.keyboard.press("k");
    await expectWhole(cards.first());
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expectWhole(cards.last());
  });
});

test.describe("a comment draft's tag", () => {
  test("its tag says Post like its button", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await expect(draft.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(needsStack(page).locator("[data-needs-you-chip]").filter({ hasText: /^Post$/ })).toHaveCount(1);
    await expect(needsStack(page).locator("[data-needs-you-chip]").filter({ hasText: /^Approve$/ })).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the comment's edit box", () => {
  test("the comment's edit box is about six lines tall at least", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const box = await needsPane(page).locator("textarea").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(150);
  });
});

test.describe("a draft the person edited", () => {
  test("is marked edited in Needs you once Done editing is pressed", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await expect(draft).toBeVisible();
    await expect(needsYouTray(page).locator("[data-needs-you-edited]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nOne more thing to answer.`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(needsStack(page).locator("[data-needs-pane-edited]").first()).toBeVisible();
  });
});

test.describe("the skip Undo names the draft", () => {
  test("the Undo toast quotes the draft's first words, and a batch leaves the other groups their rows", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    // The person edited the first, so the second stays beside it instead of replacing it.
    await keepComments(page);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await askPip(page, "move it to QA");
    await homeSettled(page);
    const sample = Number(await needsYouCount(page).innerText()) - 3;
    await expandNeedsYou(page, "CA-401");
    const comment = needRow(page, /Draft comment/).first();
    await comment.click();
    await needsPane(page).getByRole("button", { name: "Skip" }).click();
    await expect(toast(page).filter({ hasText: /^Skipped the draft on CA-401: “.+”\./ })).toHaveCount(1);
    expect(sample).toBeGreaterThan(0);
    // The rest of the group still has its rows and the batch still offers what is left.
    await expect(needsYouRow(page, "CA-401")).toBeVisible();
    const batch = needsStack(page).getByRole("button", { name: /^Approve \d+ safe drafts?$/ });
    await batch.click();
    await needsPane(page).getByRole("button", { name: /^Yes, approve \d+/ }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBeGreaterThan(0);
    // Not reproduced: the group keeps the decision a batch never takes, and General keeps its own rows.
    await expect(needsStack(page)).toContainText("An agent wrote the plan for CA-401");
    await expect(needsYouCount(page)).toHaveText(String(sample));
    await expect(needsYouRow(page, "General")).toBeVisible();
  });
});

test.describe("an edited draft reopens as a preview", () => {
  test("the kept text shows read-only with an Edit button, Edit opens the field with it, and Post posts it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Kept after the card left.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    await needsPane(page).getByRole("button", { name: "Hide" }).click();
    await expect(draft).toHaveCount(0);
    await needRow(page, /Draft comment/).click();
    await expect(draft).toContainText("Kept after the card left.");
    await expect(needsPane(page).locator("textarea")).toHaveCount(0);
    await expect(draft.getByRole("button", { name: "Done editing" })).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(needsPane(page).locator("textarea").first()).toHaveValue("Kept after the card left.");
    await expect(needsPane(page).locator("textarea").first()).toBeFocused();
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(draft.getByRole("button", { name: "Edit" })).toBeFocused();
    await draft.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.text)).toEqual([expect.stringContaining("Kept after the card left.")]);
  });
});
