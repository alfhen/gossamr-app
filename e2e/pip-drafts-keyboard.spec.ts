import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, PIP_INPUT, pipPane } from "./support/app";

// The comment the sample Pip drafts when asked for one on the open ticket (scriptPip in src/backend/mockPip.ts).
const NUDGE = "Checking in on this one. Is it still on track, or does anything need to move?";

const peek = (page: Page) => page.locator("#peek-sheet");
const card = (page: Page, name: string) => pipPane(page).getByRole("article", { name });
const stateOf = (article: ReturnType<typeof card>) => article.locator("div").first().locator("span").last();

/** Opens CA-401's peek, so Pip's drafts land on it, and then Pip. */
async function onCa401(page: Page) {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peek(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await openPip(page);
}

/** Asks the sample Pip for a comment on the open ticket and waits for the new draft card. */
async function askForComment(page: Page) {
  const before = await card(page, "Comment on CA-401").count();
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
  await expect(draft).toContainText("a approve · s skip · ↵ open");
  expect(await hintClipped(draft)).toBe(false);
  await page.keyboard.press("a");
  await expect(draft.getByRole("status")).toHaveText("↵ approve · any other key cancels");
  expect(await hintClipped(draft)).toBe(false);
  await expect(stateOf(draft)).toHaveText("Draft");
  await page.keyboard.press("Enter");

  await expect(stateOf(draft)).toHaveText("Done");
  await expect(peek(page).locator("#peek-comments").getByText(NUDGE)).toBeVisible();
});

test("text typed after ArrowUp never decides a draft and lands in the input", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  const input = page.locator(PIP_INPUT);
  const draft = card(page, "Comment on CA-401");
  const comments = peek(page).locator("#peek-comments").getByText(NUDGE);

  // As someone who expects ArrowUp to bring back their last question and then types a new one.
  await input.press("ArrowUp");
  await expect(draft).toBeFocused();
  await page.keyboard.type("add a note");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("add a note");

  await input.fill("");
  await input.press("ArrowUp");
  await page.keyboard.type("show me the drafts");
  await page.keyboard.press("Enter");
  await expect(pipPane(page).getByText("show me the drafts", { exact: true })).toBeVisible();

  await expect(stateOf(draft)).toHaveText("Draft");
  await expect(comments).toHaveCount(0);
});

test("a click on a card's text neither shows its keys nor lets a and Enter approve it", async ({ page }) => {
  await onCa401(page);
  await askForComment(page);
  const draft = card(page, "Comment on CA-401");

  await draft.getByText(NUDGE).click();
  await expect(draft).toBeFocused();
  await expect(draft.getByRole("status")).toHaveCount(0);
  expect((await ring(draft)).style).toBe("none");
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");

  await expect(stateOf(draft)).toHaveText("Draft");
  await expect(peek(page).locator("#peek-comments").getByText(NUDGE)).toHaveCount(0);
});

test("skipping the last card under Drafts waiting hands focus to the input, so j types instead of moving the canvas", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  const waiting = pipPane(page).getByRole("region", { name: "Drafts" });
  const draft = waiting.getByRole("article").last();
  const name = await draft.getAttribute("aria-label");
  const before = await waiting.getByRole("article").count();

  await page.locator(PIP_INPUT).press("ArrowUp");
  await expect(waiting.getByRole("article", { name: name! })).toBeFocused();
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(waiting.getByRole("article", { name: name! })).toHaveCount(0);

  const next = before > 1 ? waiting.getByRole("article").last() : page.locator(PIP_INPUT);
  await expect(next).toBeFocused();
  await page.keyboard.press("j");
  await expect(peek(page)).toHaveCount(0);
  if (before === 1) await expect(page.locator(PIP_INPUT)).toHaveValue("j");
});

test("a second draft reached with the arrows is skipped with s then Enter", async ({ page }) => {
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
  await expect(stateOf(second)).toHaveText("Draft");
  await page.keyboard.press("Enter");

  await expect(stateOf(second)).toHaveText("Skipped");
  await expect(stateOf(first)).toHaveText("Draft");
});

test("a on a run draft opens its setup and starts nothing", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  // Pip's strip of agents shows runs too; only the Agents view counts.
  const runs = page.locator('[data-run-id]:not(aside[aria-label="Pip"] *)');
  await expect(runs.first()).toBeVisible();
  const before = await runs.count();

  await openPip(page);
  await askPip(page, "investigate CA-401");
  const draft = card(page, "Start an agent: CA-401");
  await expect(draft).toBeVisible();
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);

  const setup = page.getByRole("dialog", { name: "Start an agent" });
  const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
  // A fresh profile's first agent action shows the safety sheet instead, once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator(PIP_INPUT).press("ArrowUp");
    await expect(draft).toBeFocused();
    await expect(draft).toContainText("s skip · ↵ open");
    await expect(draft).not.toContainText("a approve");
    await page.keyboard.press("a");
    await expect(setup.or(safety)).toBeVisible();
    if (!(await safety.isVisible())) break;
    await safety.getByRole("button", { name: "Close" }).click();
    await page.locator(PIP_INPUT).focus();
  }
  await expect(setup).toBeVisible();
  await expect(setup).toContainText("CA-401");

  await setup.getByRole("button", { name: /^(Cancel|Close)$/ }).first().click();
  await expect(setup).toHaveCount(0);
  await expect(stateOf(draft)).toHaveText("Draft");
  await expect(runs).toHaveCount(before);
});

test("the pane keeps its header, chips and input", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  const pane = pipPane(page);
  await expect(pane.getByRole("heading", { name: "Pip" })).toBeVisible();
  await expect(pane.getByText("powered by Claude")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Close Pip" })).toBeVisible();
  await expect(pane.locator('header button[aria-controls="pip-seeing"]')).toBeVisible();
  await expect(pane.getByText("I follow along as you move around.")).toBeVisible();
  await expect(page.locator(PIP_INPUT)).toBeFocused();
  await expect(page.locator(PIP_INPUT)).toHaveAttribute("aria-label", "Ask Pip");
  await expect(pane.getByRole("button", { name: "Ask" })).toBeDisabled();
  await expect(pane.locator(":scope > div.flex-wrap > button").first()).toBeVisible();
  // Order inside the pane is unchanged: header, conversation, chips, then the form last.
  const order = await pane.evaluate((el) => [...el.children].map((c) => c.tagName.toLowerCase()));
  expect(order.slice(-1)).toEqual(["form"]);
  expect(order.indexOf("header")).toBeLessThan(order.indexOf("form"));
});
