import { expect, test, type Locator, type Page } from "@playwright/test";
import { askPip, openApp, openPip, peekSheet, peekTicket, PIP_INPUT, pipPane, reviewedDraft } from "./support/app";

// A draft card's action bar is pinned to the bottom of its card: at the peek's visible bottom while the card runs on below
// it, flush with the card's own bottom once the card ends. Nothing of the card shows under it, and it is opaque and ruled
// off, so the approve action reads as solid.

test.use({ viewport: { width: 1440, height: 900 } });

const box = async (l: Locator) => (await l.boundingBox())!;
const scroller = (page: Page) => peekSheet(page).locator("[data-peek-scroll]");
/** The action bar of `card`: the row that holds `button`. */
const barOf = (card: Locator, button: string) => card.locator("[data-draft-actions]").filter({ has: card.page().getByRole("button", { name: button, exact: true }) });

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
  const bar = barOf(card, "Update description");
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
    return { inCard: !!el?.closest('article[aria-label="Update the description of CA-401"]'), inScroller: !!el?.closest("[data-peek-scroll]") };
  }, { x: b.x + b.width / 2, y: b.y + b.height + 4 });
  expect(under.inCard && under.inScroller).toBe(false);
  await expectSolid(bar);
});

test("the GitHub review's Post review bar and the comment draft's Post comment bar sit flush with their cards' bottoms", async ({ page }) => {
  const review = await reviewedDraft(page);
  await expectFlushAtEnd(page, review, barOf(review, "Post review"));

  // The review run's own comment draft, and one Pip writes: each is a short card.
  const comments = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
  const before = await comments.count();
  await openPip(page);
  await askPip(page, "Draft a comment");
  await expect(comments).toHaveCount(before + 1);
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  for (let i = 0; i <= before; i++) await expectFlushAtEnd(page, comments.nth(i), barOf(comments.nth(i), "Post comment"));
});

test("a keyboard-focused draft card in the Pip pane shows its whole focus ring, clear of the suggestion chips", async ({ page }) => {
  await openApp(page);
  await peekTicket(page, "CA-401");
  await openPip(page);
  for (let i = 0; i < 3; i++) {
    await askPip(page, "Draft a comment");
    await expect(pipPane(page).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(i + 1);
    await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  }
  const cards = pipPane(page).getByRole("article", { name: "Comment on CA-401" });
  const chips = pipPane(page).getByRole("button", { name: "What are my agents doing?" }).locator("..");
  const conversation = pipPane(page).locator("[data-pip-conversation-body]");

  /** The focused card with its 2px ring 2px out lies inside the conversation's scroll box and clear of the chips. */
  const expectWhole = async (card: Locator) => {
    await expect(card).toBeFocused();
    const ring = 4;
    const c = await box(card);
    const s = await box(conversation);
    expect(c.y - ring).toBeGreaterThanOrEqual(s.y - 0.5);
    expect(c.y + c.height + ring).toBeLessThanOrEqual(s.y + s.height + 0.5);
    const k = await box(chips);
    expect(c.y + c.height + ring).toBeLessThanOrEqual(k.y + 0.5);
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
