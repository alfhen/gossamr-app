import { expect, type Page, test } from "@playwright/test";
import {
  askPip, closeWorkstreamSheet, draftOpen, finishOnHome, homeConversation, homeConversationRegion, homeSettled,
  INSTANT_PIP, MANUAL_PRS, mockRuns, openAgents, openApp, openPip, peekSheet, PIP_INPUT, pipIdle, pipPane,
  reviewedDraft, seedWorkstreamEvent, selectWorkstream, showWorkspace, startWorkstream, VAGUE_TICKET,
} from "./support/app";
import { newest } from "./support/steps";

/** Where the sample backend keeps Pip's turns (KEY in src/backend/mockPipTurns.ts). */
const STORE = "gossamr-mock-pip-turns";

const QUESTION = "What am I looking at?";

const ANSWER = "Ask me to show stale or blocked tickets";

interface Kept {
  requestId: string;
  prompt: string;
  status: string;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

const kept = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as Kept[], STORE);

/** Opens Pip unless the page kept it open across the reload. */
async function showPip(page: Page) {
  if (!(await pipPane(page).isVisible())) await openPip(page);
}

/** Asks Pip and waits until the answer is in and the turn is over. */
async function askAndWait(page: Page, question: string, answer: string) {
  await askPip(page, question);
  await expect(pipPane(page).getByText(answer).last()).toBeVisible();
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

const FIRST = "What am I looking at?";

const FIRST_ANSWER = "Ask me to show stale or blocked tickets";

const SECOND = "Show me the blocked tickets";

const SECOND_ANSWER = "I filtered this view for you";

const QUEUED = "Queued, runs after the current answer";

interface KeptPipQueue {
  requestId: string;
  prompt: string;
  status: string;
  error: string | null;
  sessionId: string | null;
}

const keptPipQueue = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as KeptPipQueue[], STORE);

/** Where `text` first appears in the pane's text, so the order of answers can be compared. */
async function offset(page: Page, text: string) {
  const all = await pipPane(page).innerText();
  return all.indexOf(text);
}

const timeline = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");

/**
 * A workstream on CA-401 opened on Pip home, its investigation asked of Pip: the chain's
 * first run. Returns the investigation.
 */
async function investigating(page: Page) {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await askPip(page, "investigate this");
  await homeSettled(page);
  await expect.poll(() => newest(page, "investigate")).not.toBeNull();
  return (await newest(page, "investigate"))!;
}

test("the pane keeps its header and input", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  const pane = pipPane(page);
  await expect(pane.getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(pane.getByText("powered by Claude")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Close Pip" })).toBeVisible();
  await expect(pane.locator('header button[aria-controls="pip-seeing"]')).toBeVisible();
  await expect(pane.getByText("Ask me about a ticket, or tell me what to show or draft.")).toBeVisible();
  await expect(page.locator(PIP_INPUT)).toBeFocused();
  await expect(page.locator(PIP_INPUT)).toHaveAttribute("aria-label", "Ask Pip");
  await expect(pane.getByRole("button", { name: "Ask" })).toBeDisabled();
  // Order inside the pane: header, conversation, then the form, with the status line under it.
  const order = await pane.evaluate((el) => [...el.children].map((c) => c.tagName.toLowerCase()));
  expect(order.slice(-2)).toEqual(["form", "p"]);
  expect(order.indexOf("header")).toBeLessThan(order.indexOf("form"));
});

test.describe("Pip's conversation is kept", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await openPip(page);
  });

  test("a finished conversation is shown again after a reload", async ({ page }) => {
    await askAndWait(page, QUESTION, ANSWER);
    await page.reload();
    await showWorkspace(page);
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await showPip(page);
    await expect(pipPane(page).getByText(QUESTION, { exact: true })).toBeVisible();
    await expect(pipPane(page).getByText(ANSWER)).toBeVisible();
  });

  test("the conversation survives a restart and a follow-up continues it", async ({ page, context }) => {
    await askAndWait(page, QUESTION, ANSWER);
    const first = (await kept(page)).find((t) => t.prompt === QUESTION);
    expect(first?.sessionId).toBeTruthy();

    await page.close();
    const again = await context.newPage();
    await openApp(again);
    await showPip(again);
    await expect(pipPane(again).getByText(QUESTION, { exact: true })).toBeVisible();
    await expect(pipPane(again).getByText(ANSWER)).toBeVisible();

    await askAndWait(again, "Show me the blocked tickets", "Blocked tickets. I filtered this view");
    const turns = await kept(again);
    expect(turns.map((t) => t.prompt)).toEqual([QUESTION, "Show me the blocked tickets"]);
    expect(turns[1].sessionId).toBe(first?.sessionId);
    await expect(pipPane(again).getByText(QUESTION, { exact: true })).toBeVisible();
  });

  test("each turn's usage is recorded in the store", async ({ page }) => {
    await askAndWait(page, QUESTION, ANSWER);
    const turn = (await kept(page)).find((t) => t.prompt === QUESTION);
    expect(turn?.status).toBe("done");
    expect(turn?.requestId).toBeTruthy();
    expect(turn?.usage?.inputTokens).toBeGreaterThan(0);
    expect(turn?.usage?.outputTokens).toBeGreaterThan(0);
    expect(turn?.usage?.costUsd).toBeGreaterThan(0);
  });

  test("a reload mid-answer doesn't stop Pip: the turn carries on and ends as answered", async ({ page }) => {
    // Reloading the page leaves the app running in Tauri, so the answer goes on; slowed so the reload lands mid-answer.
    await openApp(page, "pipPace=150");
    await showPip(page);
    await askPip(page, QUESTION);
    const pane = pipPane(page);
    await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.reload();
    await showWorkspace(page);

    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await showPip(page);
    await expect(pane.getByText(QUESTION, { exact: true })).toHaveCount(1);
    await expect(pane.getByText(ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(pane.getByRole("alert")).toHaveCount(0);
    expect((await kept(page)).map((t) => [t.prompt, t.status])).toEqual([[QUESTION, "done"]]);
    await expect(page.locator(PIP_INPUT)).toBeEnabled();
  });

  test("a restart cuts off the running turn and the queued one, each said its own way", async ({ page, context }) => {
    test.setTimeout(60_000);
    await openApp(page, "pipPace=200");
    await showPip(page);
    await askPip(page, QUESTION);
    await askPip(page, "Show me the blocked tickets");
    await expect(pipPane(page).getByText("Queued, runs after the current answer")).toBeVisible();

    // A new tab starts the sample app afresh, as quitting and opening the app does.
    await page.close();
    const again = await context.newPage();
    await openApp(again, "pipPace=200");
    await showPip(again);
    const pane = pipPane(again);
    await expect(pane.getByRole("alert")).toHaveText(["Gossamr closed before Pip finished", "Gossamr closed before this question ran"]);
    await expect(pane.getByText(/^Looking at/)).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
    expect((await kept(again)).map((t) => t.status)).toEqual(["failed", "failed"]);
    await expect(again.locator(PIP_INPUT)).toBeEnabled();
  });

  test("the draft a turn made is still under it after a reload, once, even when the reload came mid-answer", async ({ page }) => {
    await openApp(page, "pipPace=150");
    await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
    await showPip(page);
    const pane = pipPane(page);
    const comment = pane.getByRole("article", { name: "Comment on CA-401" });
    await askPip(page, "Draft a comment");
    await expect(comment).toHaveCount(1);
    await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.reload();
    await showWorkspace(page);

    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await showPip(page);
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 20_000 });
    await expect(pane.getByText("It isn't posted; approve, edit or skip it below.")).toBeVisible();
    await expect(comment).toHaveCount(1);

    await page.reload();
    await showWorkspace(page);
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await showPip(page);
    await expect(pane.getByText("Draft a comment", { exact: true })).toBeVisible();
    await expect(comment).toHaveCount(1);
    // It is the turn's draft, under its answer, not one left over from before.
    await expect(pane.getByRole("region", { name: "Drafts" }).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(0);
  });
});

test.describe("Pip's questions queue", () => {
  // Slow enough that the second question is sent while the first is still being answered.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page, "pipPace=200");
    await openPip(page);
  });

  test("a second question waits its turn and is answered after the first, and both come back after a reload", async ({ page }) => {
    const pane = pipPane(page);
    await askPip(page, FIRST);
    await askPip(page, SECOND);

    await expect(pane.getByText(QUEUED)).toBeVisible();
    await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(pane.getByText(SECOND_ANSWER)).toHaveCount(0);

    await expect(pane.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByText(QUEUED)).toHaveCount(0, { timeout: 5_000 });
    await expect(pane.getByText(SECOND_ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);

    expect(await offset(page, FIRST_ANSWER)).toBeLessThan(await offset(page, SECOND));
    expect(await offset(page, SECOND)).toBeLessThan(await offset(page, SECOND_ANSWER));
    const turns = await keptPipQueue(page);
    expect(turns.map((t) => [t.prompt, t.status])).toEqual([
      [FIRST, "done"],
      [SECOND, "done"],
    ]);
    expect(turns[1].sessionId).toBe(turns[0].sessionId);

    await page.reload();
    // The drawer is closed again after a reload: it is open for the session only.
    await expect(page.locator("[data-pip-launcher]")).toBeVisible();
    await expect(pipPane(page)).toHaveCount(0);
    await openPip(page);
    await expect(pane.getByText(FIRST, { exact: true })).toBeVisible();
    await expect(pane.getByText(SECOND, { exact: true })).toBeVisible();
    await expect(pane.getByText(SECOND_ANSWER)).toBeVisible();
    expect(await offset(page, FIRST)).toBeLessThan(await offset(page, FIRST_ANSWER));
    expect(await offset(page, FIRST_ANSWER)).toBeLessThan(await offset(page, SECOND));
    expect(await offset(page, SECOND)).toBeLessThan(await offset(page, SECOND_ANSWER));
    await expect(pane.getByText(QUEUED)).toHaveCount(0);
  });

  test("Stop ends only the answer in progress, and the queued question then runs to the end", async ({ page }) => {
    const pane = pipPane(page);
    await askPip(page, FIRST);
    await askPip(page, SECOND);
    await expect(pane.getByText(QUEUED)).toBeVisible();

    await pane.getByRole("button", { name: "Stop" }).click();
    await expect(pane.getByRole("alert")).toHaveText("Stopped");
    await expect(pane.getByText(QUEUED)).toHaveCount(0);
    await expect(pane.getByText(SECOND_ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(pane.getByRole("alert")).toHaveCount(1);
    expect((await keptPipQueue(page)).map((t) => [t.prompt, t.status])).toEqual([
      [FIRST, "failed"],
      [SECOND, "done"],
    ]);
  });

  test("Remove takes a queued question out before it runs", async ({ page }) => {
    const pane = pipPane(page);
    await askPip(page, FIRST);
    await askPip(page, SECOND);
    await expect(pane.getByText(QUEUED)).toBeVisible();

    await pane.getByRole("button", { name: "Remove this question" }).click();
    await expect(pane.getByText(QUEUED)).toHaveCount(0);
    await expect(pane.getByText("Removed before it started")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();

    await expect(pane.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
    // The queue starts the next turn in the same step that ends the first, so once the first is stored as done, a second
    // that was still queued would be running by now.
    await expect.poll(async () => (await keptPipQueue(page)).find((t) => t.prompt === FIRST)?.status).toBe("done");
    expect((await keptPipQueue(page)).find((t) => t.prompt === SECOND)?.status).toBe("failed");
    await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(pane.getByText(SECOND_ANSWER)).toHaveCount(0);
    await expect(pane.getByText("Searched the items")).toHaveCount(0);
    const second = (await keptPipQueue(page)).find((t) => t.prompt === SECOND);
    expect([second?.status, second?.error]).toEqual(["failed", "Removed before it started"]);
  });
});

test("the Pip pane shows the workstream's timeline over its composer, with a filter of its own", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  const pane = pipPane(page);
  const paneTimeline = pane.locator("[data-timeline]");
  await expect(paneTimeline).toBeVisible();
  // The workstream's opening line is its first entry; no old run strip or Drafts waiting list.
  await expect(paneTimeline.locator('[data-timeline-entry][data-kind="audit"]').first()).toBeVisible();
  await expect(pane.getByRole("region", { name: "Your agents" })).toHaveCount(0);
  await expect(pane.getByRole("region", { name: "Drafts" })).toHaveCount(0);

  await askPip(page, "Draft a comment");
  await expect.poll(() => pipIdle(page)).toBe(true);
  const asked = paneTimeline.locator('[data-timeline-entry][data-kind="said"]', { hasText: "Draft a comment" });
  await expect(asked).toHaveCount(1);
  const draft = paneTimeline.locator('[data-timeline-entry][data-kind="draft"] article[data-draft]').last();
  await expect(draft).toBeVisible();
  // The composer is still the pane's.
  await expect(pane.locator(PIP_INPUT)).toBeVisible();

  // ArrowUp from the empty composer reaches the newest draft, and again walks back up the timeline (a letter there would
  // go back to the input).
  await pane.locator(PIP_INPUT).press("ArrowUp");
  await expect(draft).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(draft).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Pip"] [data-timeline-entry]'))).toBe(true);

  // The pane's own filter: Drafts shows its drafts alone.
  const paneFilter = pane.getByRole("group", { name: "Filter", exact: true });
  await paneFilter.getByRole("button", { name: /^Drafts\b/ }).click();
  await expect(paneFilter.getByRole("button", { name: /^Drafts\b/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await paneTimeline.locator("[data-timeline-entry]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).every((k) => k === "draft")).toBe(true);
  await expect(paneTimeline.locator("[data-timeline-entry]").first()).toBeVisible();
  await paneFilter.getByRole("button", { name: /^All\b/ }).click();
  await expect(asked).toHaveCount(1);
});

test("a new turn keeps the place of someone reading older entries, and follows someone at the end", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const r1 = await investigating(page);
  const body = timeline(page);
  const metrics = () => body.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  await expect.poll(async () => (await metrics()).max).toBeGreaterThan(40);
  // At the end, the wake that run's finish brings follows the person down.
  await expect.poll(async () => { const m = await metrics(); return m.max - m.top; }).toBeLessThanOrEqual(24);
  // Scrolled up to older entries, it doesn't.
  await body.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect.poll(async () => (await metrics()).top).toBe(0);
  await finishOnHome(page, r1.id);
  expect((await metrics()).top).toBe(0);
  // Asking Pip lands at the end, wherever they were reading.
  await askPip(page, "what next?");
  await homeSettled(page);
  await expect.poll(async () => { const m = await metrics(); return m.max - m.top; }).toBeLessThanOrEqual(24);
});

test.describe("Pip's chat hides the machinery", () => {
  /** Pip's tool names, which the person should never read. */
  const TOOL_NAME = /\b(get|list|propose|revise|retire|set)_[a-z_]+/;

  const settled = (page: Page) => expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);

  const lastBubble = (page: Page) => pipPane(page).locator("[data-user-bubble]").last();

  test("Discuss with Pip on an agent's comment draft shows a short line, never the instruction, its ids or Pip's tools", async ({ page }) => {
    await reviewedDraft(page);
    const reviewRun = (await mockRuns(page)).find((r) => r.step === "review" && r.key === "CA-402")!;
    const comment = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
    await expect(comment).toHaveCount(1);
    const draftId = await comment.evaluate((el) => el.closest("[data-draft]")?.getAttribute("data-draft") ?? el.getAttribute("data-draft"));

    await comment.getByRole("button", { name: "Ask Pip" }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(lastBubble(page)).toHaveText("Ask Pip about this draft");
    await settled(page);

    const text = await pipPane(page).innerText();
    expect(text).not.toMatch(TOOL_NAME);
    expect(text).not.toMatch(/mock-\d+/);
    expect(text).not.toContain(reviewRun.id);
    if (draftId) expect(text).not.toContain(draftId);
  });

  test("Discuss with Pip on a run's sheet shows its short line too, and sends Pip the draft by id, out of sight", async ({ page }) => {
    await reviewedDraft(page);
    const reviewRun = (await mockRuns(page)).find((r) => r.step === "review" && r.key === "CA-402")!;
    const comment = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
    await expect(comment).toHaveCount(1);
    const draftId = await comment.getAttribute("data-draft");
    // The comment card names its run; that name opens the run's sheet.
    await comment.locator("[data-provenance=run]").getByRole("button", { name: "the CA-402 review" }).click();
    const sheet = page.getByRole("dialog", { name: "Agent run" });
    await expect(sheet).toHaveCount(1);
    await sheet.getByRole("button", { name: "Ask Pip" }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(lastBubble(page)).toHaveText("Ask Pip about this report");
    await settled(page);
    const text = await pipPane(page).innerText();
    expect(text).not.toMatch(TOOL_NAME);
    expect(text).not.toContain(reviewRun.id);
    if (draftId) expect(text).not.toContain(draftId);
    expect(text).not.toContain("drafted from agent run");
  });

  test("every ticket key in Pip's answer about the agents is a link, and one the cache doesn't hold opens a live peek", async ({ page }) => {
    await openApp(page);
    await openPip(page);
    await askPip(page, "What are my agents doing?");
    const answer = pipPane(page).locator("[data-pip-answer]").last();
    await expect(answer).toContainText("agent runs");
    await settled(page);

    const keys = await answer.evaluate((el) => {
      const out: { key: string; linked: boolean }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const m of (node.textContent ?? "").matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) out.push({ key: m[0], linked: !!node.parentElement?.closest("button") });
      }
      return out;
    });
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.filter((k) => !k.linked)).toEqual([]);
    for (const key of ["CA-377", "DEVOPS-455"]) expect(keys.map((k) => k.key)).toContain(key);

    await answer.getByRole("button", { name: "DEVOPS-455" }).click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for DEVOPS-455");
    await expect(page.getByText("Couldn't find DEVOPS-455")).toHaveCount(0);
  });
});

test("the timeline keeps the entry being read in place when a draft above it is approved", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await draftOpen(page);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 3; i++) {
    await askPip(page, "Draft a comment");
    await homeSettled(page);
  }
  const body = page.locator("[data-timeline]");
  const entries = body.locator("[data-timeline-entry]");
  await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  // At the end it stays at the end.
  await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(25);
  // Scrolled up to an entry, that entry keeps its place as an entry above it changes height (the browser's own anchoring is off here, so it is the timeline's that is tested).
  // Two frames after the scroll, so the timeline has handled its scroll event and noted the entry before the pad goes in.
  await body.evaluate(async (el) => {
    el.style.overflowAnchor = "none";
    el.scrollTop = el.scrollHeight / 2;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  const reading = await body.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const li = Array.from(el.querySelectorAll("[data-timeline-entry]")).find((x) => x.getBoundingClientRect().bottom > top + 40)!;
    return li.getAttribute("data-timeline-entry")!;
  });
  const mine = body.locator(`[data-timeline-entry="${reading}"]`);
  const before = await mine.evaluate((el) => el.getBoundingClientRect().top);
  await entries.first().evaluate((el) => {
    const pad = document.createElement("div");
    pad.style.height = "240px";
    el.prepend(pad);
  });
  await expect.poll(() => mine.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(Math.round(before));
});

test.describe("dates in the timeline", () => {
  test("an entry from an earlier day sits under its date, and a timeline of today's entries has none", async ({ page }) => {
    await openApp(page, INSTANT_PIP);
    await startWorkstream(page, VAGUE_TICKET);
    await openAgents(page);
    await selectWorkstream(page, VAGUE_TICKET);
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
    await seedWorkstreamEvent(page, VAGUE_TICKET, { actor: "person", action: "paused", at: yesterday });
    await closeWorkstreamSheet(page);
    await selectWorkstream(page, VAGUE_TICKET);
    const heads = timeline.locator("[data-timeline-day]");
    await expect(heads.first()).toBeVisible();
    await expect(heads.first()).toHaveText(/^(Yesterday|Today|[A-Z][a-z]+day)$/);
    // The first entry of today has its own header once an earlier day is listed.
    await expect(heads.last()).toHaveText("Today");
    // Walking the entries with j and k does not stop on a header.
    expect(await timeline.locator("[data-timeline-day][tabindex]").count()).toBe(0);
  });

  test("a timeline left open over local midnight puts today's entries under Yesterday, though no entry changed", async ({ page }) => {
    const now = new Date();
    await page.clock.install({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 57) });
    await openApp(page, INSTANT_PIP);
    await startWorkstream(page, VAGUE_TICKET);
    await openAgents(page);
    await selectWorkstream(page, VAGUE_TICKET);
    const timeline = pipPane(page).locator("[data-timeline]");
    await expect(timeline.locator("[data-timeline-entry]").first()).toBeVisible();
    await expect(timeline.locator("[data-timeline-day]")).toHaveCount(0);
    const entries = await timeline.locator("[data-timeline-entry]").count();
    await page.clock.runFor(5 * 60_000);
    await expect(timeline.locator("[data-timeline-day]").first()).toHaveText("Yesterday");
    expect(await timeline.locator("[data-timeline-entry]").count()).toBe(entries);
  });
});
