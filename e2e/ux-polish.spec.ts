import { expect, test, type Locator, type Page } from "@playwright/test";
import { PIP_INPUT, advanceRuns, agentsSettled, askPip, holdAll, homeConversation, homeConversationRegion, mockRuns, needsYouTray, openApp, openPip, openPipHome, peekSheet, peekTicket, pipHome, pipIdle, pipPane, reviewedDraft, setManage, startWorkstream, stepRail, workstreamRow } from "./support/app";

// The UX polish pass: what the person reads (no ids, tools or machinery words), where things sit (nothing covers
// anything), draft action bars, and how a new workstream opens.

test.describe("hidden machinery", () => {
  /** Pip's tool names, which the person should never read. */
  const TOOL_NAME = /\b(get|list|propose|revise|retire|set)_[a-z_]+/;

  const settled = (page: Page) => expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);

  const lastBubble = (page: Page) => pipPane(page).locator("[data-user-bubble]").last();

  test("Discuss with Pip on a review draft shows a short line, and Pip names the draft and the run, never their ids or its tools", async ({ page }) => {
    const review = await reviewedDraft(page);
    const reviewRun = (await mockRuns(page)).find((r) => r.kind === "review" && r.key === "CA-402")!;
    expect(reviewRun).toBeTruthy();

    // The draft card names the run by ticket and step, and its link opens it.
    const from = review.locator("[data-provenance=run]");
    await expect(from).toContainText("From the CA-402 review");
    await expect(from).not.toContainText(/\b[0-9a-f]{8}\b/);
    // What gets posted to GitHub names the review by its ticket, not by the run's id, which a pull request's author can't use.
    const summary = await review.getByRole("textbox", { name: "Review summary" }).inputValue();
    expect(summary).toMatch(/\n\nDrafted by a Gossamr agent reviewing CA-402; posted only after a person approved it in Gossamr\.$/);
    expect(summary).not.toContain(reviewRun.id);
    if (reviewRun.shortId) expect(summary).not.toContain(reviewRun.shortId);
    expect(summary).not.toMatch(/agent run [0-9a-z-]{6,}/);

    await review.getByRole("button", { name: "Discuss with Pip" }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(lastBubble(page)).toHaveText("Discuss this review");
    await expect(pipPane(page)).toContainText("I read the review of acme/webshop#218 in full");
    await settled(page);

    const text = await pipPane(page).innerText();
    expect(text).not.toMatch(TOOL_NAME);
    expect(text).not.toMatch(/mock-\d+/);
    expect(text).not.toContain("mock-run-");
    expect(text).not.toContain(reviewRun.id);
    if (reviewRun.shortId) expect(text).not.toContain(reviewRun.shortId);
    expect(text).toContain("acme/webshop#218");

    // The stored turn keeps the short line: a reload shows it again, not the instruction Pip was given.
    await page.reload();
    // The sample backend starts over on a reload, so it asks what to watch again, and lands on Pip home; Pip's turns are kept.
    await page.getByRole("button", { name: "Start watching" }).click();
    const home = homeConversationRegion(page);
    await expect(home.locator("[data-user-bubble]").last()).toHaveText("Discuss this review");
    await expect(home).toContainText("I read the review of acme/webshop#218 in full");
    expect(await home.innerText()).not.toMatch(TOOL_NAME);
  });

  test("Discuss with Pip on an agent's comment draft shows a short line, never the instruction, its ids or Pip's tools", async ({ page }) => {
    await reviewedDraft(page);
    const reviewRun = (await mockRuns(page)).find((r) => r.kind === "review" && r.key === "CA-402")!;
    const comment = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
    await expect(comment).toHaveCount(1);
    const draftId = await comment.evaluate((el) => el.closest("[data-draft]")?.getAttribute("data-draft") ?? el.getAttribute("data-draft"));

    await comment.getByRole("button", { name: "Discuss with Pip" }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(lastBubble(page)).toHaveText("Discuss this draft");
    await settled(page);

    const text = await pipPane(page).innerText();
    expect(text).not.toMatch(TOOL_NAME);
    expect(text).not.toMatch(/mock-\d+/);
    expect(text).not.toContain(reviewRun.id);
    if (draftId) expect(text).not.toContain(draftId);
  });

  test("Discuss with Pip on a run's sheet shows its short line too, and sends Pip the draft by id, out of sight", async ({ page }) => {
    await reviewedDraft(page);
    const reviewRun = (await mockRuns(page)).find((r) => r.kind === "review" && r.key === "CA-402")!;
    const comment = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
    await expect(comment).toHaveCount(1);
    const draftId = await comment.getAttribute("data-draft");
    // The comment card names its run; that name opens the run's sheet.
    await comment.locator("[data-provenance=run]").getByRole("button", { name: "the CA-402 review" }).click();
    const sheet = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Discuss with Pip" }) });
    await expect(sheet).toHaveCount(1);
    await sheet.getByRole("button", { name: "Discuss with Pip" }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(lastBubble(page)).toHaveText("Discuss this draft");
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

test.describe("no overlap", () => {
  type Box = { x: number; y: number; width: number; height: number };

  const box = async (l: Locator): Promise<Box> => {
    const b = await l.boundingBox();
    if (!b) throw new Error("not on screen");
    return b;
  };

  const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  const toasts = (page: Page) => page.locator("[data-toast]");

  /** The left rail: the aside that holds the Workspace navigation (Rail.tsx). */
  const rail = (page: Page) => page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) });

  /** The one toast on screen is clear of `others`. */
  async function clearOf(page: Page, others: Locator[]) {
    await expect(toasts(page)).toHaveCount(1);
    const t = await box(toasts(page));
    for (const o of others) expect(intersects(t, await box(o)), `toast over ${o}`).toBe(false);
  }

  /** What the person navigates and types with on the workspace: none of it is ever under a toast. */
  const controls = (page: Page) => [
    page.getByRole("tablist", { name: "Views" }),
    page.getByRole("group", { name: "View" }),
    page.getByRole("button", { name: "New tab" }),
    page.locator("main footer").first(),
  ];

  test("(e1) toasts come one at a time, bottom right of the canvas, clear of the tabs, the peek, Pip's input, the Needs you tray and the footer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    // Hold all twice, back to back: each says what it did in a toast.
    await startWorkstream(page, "CA-401");
    await holdAll(page, "shortcut");
    await holdAll(page, "shortcut");

    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page)).toContainText("Held 1 workstream");
    await expect(toasts(page)).toContainText("+1 more");
    // The peek and the Pip pane are open: the toast is left of the peek, clear of its sections and of Pip's input.
    await expect(peekSheet(page)).toBeVisible();
    await clearOf(page, [...controls(page), peekSheet(page), page.locator(PIP_INPUT)]);

    // Dismissing the first brings the second, alone.
    await toasts(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page)).toContainText("Every open workstream is held already");
    await expect(toasts(page)).not.toContainText("more");

    // With the pane closed it stacks above Pip's launcher, never over it.
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+j");
    await expect(pipPane(page)).toHaveCount(0);
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    await clearOf(page, [...controls(page), launcher]);

    // On Pip home it is clear of the Needs you tray, the conversation's header, the Steps heading and the home composer too.
    await openPipHome(page);
    await expect(needsYouTray(page)).toBeVisible();
    await clearOf(page, [needsYouTray(page), homeConversationRegion(page).locator("header").first(), stepRail(page).getByRole("heading", { name: "Steps" }), page.locator(PIP_INPUT), page.locator("[data-pip-home-hints]")]);

    // An info toast goes away by itself.
    await expect(toasts(page)).toHaveCount(0, { timeout: 8000 });
  });

  test("(e1b) a note that waited too long behind another is dropped rather than shown late", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await startWorkstream(page, "CA-401");
    await holdAll(page, "shortcut");
    await holdAll(page, "shortcut");
    await expect(toasts(page)).toContainText("+1 more");
    // The second note waits behind the first for the first's whole life, too long to still be news: it never shows.
    await expect(toasts(page)).toHaveCount(0, { timeout: 8000 });
  });

  test("(e2) the last row of the list scrolls clear of the floating Pip button and its bubble", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await expect(pipPane(page)).toHaveCount(0);
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher.getByRole("button", { name: /^Ask Pip/ })).toBeVisible();
    // A run finishing puts Pip's offer to sum it up in a bubble beside the launcher.
    const working = (await mockRuns(page)).find((r) => r.state === "working")!;
    expect(working).toBeTruthy();
    await expect.poll(async () => (await advanceRuns(page, 1, working.id), (await mockRuns(page)).find((r) => r.id === working.id)?.state)).toBe("done");
    const nudge = launcher.locator("[data-pip-nudge] > *");
    await expect(nudge.first()).toBeVisible({ timeout: 5000 });
    await expect(nudge.first()).toContainText("Want me to sum up what it found?");

    const list = page.getByRole("listbox", { name: "Items" });
    await list.evaluate((el) => {
      const scroller = el.parentElement!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    const last = list.getByRole("option").last();
    await expect(last).toBeInViewport();
    const row = await box(last);
    expect(intersects(row, await box(launcher.getByRole("button", { name: /^Ask Pip/ })))).toBe(false);
    await expect(nudge.first()).toBeVisible();
    expect(intersects(row, await box(nudge.first()))).toBe(false);
    // The assignee avatar at the row's end is in view, above the footer.
    const footer = await box(page.locator("main footer").first());
    expect(row.y + row.height).toBeLessThanOrEqual(footer.y + 1);

    // Taking up the offer asks about that run, and Pip answers about that run, not with a roll-call of every agent.
    await nudge.first().getByRole("button", { name: /Want me to sum up/ }).click();
    await expect(pipPane(page)).toBeVisible();
    await expect(pipPane(page).locator("[data-user-bubble]").last()).toHaveText(/^What did the .+ find\?$/);
    const answer = pipPane(page).locator("[data-pip-answer]").last();
    await expect(answer).toContainText("I read the whole result of");
    await expect(answer).not.toContainText("agent runs");
    await expect(answer).not.toContainText(working.id);
  });

  test("(e3) with the peek and the Pip pane open the canvas reflows beside the peek, tabs whole and badges uncut", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await peekTicket(page, "CA-402");
    await openPip(page);
    const peek = peekSheet(page);
    // The peek slides in; wait for it to settle where it stays.
    await expect
      .poll(async () => {
        const at = (await box(peek)).x;
        await page.waitForTimeout(150);
        return Math.abs((await box(peek)).x - at) < 0.5;
      })
      .toBe(true);
    const pane = await box(pipPane(page));
    expect((await box(peek)).x + (await box(peek)).width).toBeLessThanOrEqual(pane.x + 1);
    const peekLeft = async () => (await box(peek)).x;

    // The canvas's lists and tabs stop at the peek's left edge.
    const list = page.getByRole("listbox", { name: "Items" });
    await expect.poll(async () => (await box(list)).x + (await box(list)).width).toBeLessThanOrEqual((await peekLeft()) + 1);
    const tablist = page.getByRole("tablist", { name: "Views" });
    expect((await box(tablist)).x + (await box(tablist)).width).toBeLessThanOrEqual((await peekLeft()) + 1);

    // Every tab is whole: its own text isn't cut, and the strip shows only whole tabs, left of the peek.
    for (const tab of await page.getByRole("tab").all()) {
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await tablist.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
    const strip = await box(tablist);
    /** How each tab sits in the strip as the app left it, nothing scrolled by the test: "in", "out" or "cut". */
    const placed = async () => {
      const s = await box(tablist);
      return Promise.all(
        (await page.getByRole("tab").all()).map(async (t) => {
          const b = await box(t);
          if (b.x >= s.x - 1 && b.x + b.width <= s.x + s.width + 1) return "in";
          return b.x + b.width <= s.x + 1 || b.x >= s.x + s.width - 1 ? "out" : "cut";
        }),
      );
    };
    expect(await placed()).not.toContain("cut");
    // The strip narrowed as the peek and the pane opened, and the view the person is in stayed on it.
    const selected = page.getByRole("tab", { selected: true });
    await expect(selected).toHaveText(/^Everything/);
    const tab = await box(selected);
    expect(tab.x).toBeGreaterThanOrEqual(strip.x - 1);
    expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    expect(tab.x + tab.width).toBeLessThanOrEqual((await peekLeft()) + 1);
    // Tabs that don't fit are counted on a button either side, which shows them, still whole.
    const hidden = (await placed()).filter((p) => p === "out").length;
    expect(hidden).toBeGreaterThan(0);
    const earlier = page.getByRole("button", { name: /^Show \d+ earlier tabs?$/ });
    const later = page.getByRole("button", { name: /^Show \d+ more tabs?$/ });
    await expect(earlier.or(later).first()).toBeVisible();
    for (const more of [earlier, later]) {
      if (!(await more.isVisible())) continue;
      const b = await box(more);
      expect(b.x + b.width).toBeLessThanOrEqual((await peekLeft()) + 1);
    }
    await expect(earlier).toBeVisible();
    for (let i = 0; i < 5 && (await earlier.isVisible()); i++) {
      await earlier.click();
      expect(await placed()).not.toContain("cut");
    }
    await expect(earlier).toBeHidden();
    await expect.poll(async () => (await placed())[0]).toBe("in");
    expect(await placed()).not.toContain("cut");
    // Choosing a tab from the keyboard brings the strip back to it.
    await page.getByRole("tab", { name: /^Your turn/ }).click();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { selected: true })).not.toHaveText(/^Your turn/);
    const now = await box(page.getByRole("tab", { selected: true }));
    const stripNow = await box(tablist);
    expect(now.x).toBeGreaterThanOrEqual(stripNow.x - 1);
    expect(now.x + now.width).toBeLessThanOrEqual(stripNow.x + stripNow.width + 1);
    expect(await placed()).not.toContain("cut");

    // Row titles end in an ellipsis rather than running on, and no badge reaches under the peek.
    const title = list.locator("[data-row-title]").first();
    expect(await title.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    // A narrow row shortens its title before it gives up a badge: a blocked ticket that needs you still says both.
    const blocked = list.getByRole("option").filter({ hasText: "DEVOPS-471" });
    await expect(blocked.locator("[data-row-badges]")).toHaveAttribute("data-row-badges", "full");
    for (const badge of [blocked.getByText("Your turn", { exact: true }), blocked.getByText("⛓ blocked", { exact: true })]) {
      await expect(badge).toBeVisible();
      const b = await box(badge);
      const cell = await box(blocked.locator("[data-row-badges]"));
      expect(b.y + b.height).toBeLessThanOrEqual(cell.y + cell.height + 1);
      expect(b.x + b.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
    }
    await expect(blocked.locator("[data-row-title]")).toHaveAttribute("title", /· Your turn · blocked/);
    for (const badge of await list.getByText(/^(⛓ blocked|Your turn)$/).all()) {
      const b = await box(badge);
      expect(b.x + b.width).toBeLessThanOrEqual((await peekLeft()) + 1);
    }
  });

  test("(e4) a row too narrow for its badges in words shows each as an icon with its name and a tooltip, never drops one", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await openApp(page);
    await peekTicket(page, "CA-402");
    await openPip(page);
    const list = page.getByRole("listbox", { name: "Items" });
    const blocked = list.getByRole("option").filter({ hasText: "DEVOPS-471" });
    await expect(blocked.locator("[data-row-badges]")).toHaveAttribute("data-row-badges", "compact");
    const cell = await box(blocked.locator("[data-row-badges]"));
    for (const [name, title] of [["Your turn", /^Your turn: an unread update/], ["Blocked", /^Blocked$/]] as const) {
      const icon = blocked.getByRole("img", { name, exact: true }).last();
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute("title", title);
      const b = await box(icon);
      expect(b.x + b.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(cell.y + cell.height + 1);
    }
    // Every row with a badge still shows one, in words or as an icon.
    for (const row of await list.locator("[data-row-badges]").all()) {
      if (!(await row.evaluate((el) => el.childElementCount))) continue;
      const first = await box(row.locator(":scope > *").first());
      expect(first.width).toBeGreaterThan(4);
    }
    // With room again the words come back.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("ControlOrMeta+j");
    await expect(pipPane(page)).toHaveCount(0);
    await expect(blocked.locator("[data-row-badges]")).toHaveAttribute("data-row-badges", "full");
    await expect(blocked.getByText("⛓ blocked", { exact: true })).toBeVisible();
  });

  test("(f) every rail button is named and shows its name on hover and on keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    const buttons = rail(page).getByRole("button");
    expect(await buttons.count()).toBeGreaterThan(5);
    for (const b of await buttons.all()) expect((await b.getAttribute("aria-label"))?.trim()).toBeTruthy();

    for (const name of ["Search and jump", "All projects", /^Pip home/, "Settings", "Pip"]) {
      const button = rail(page).getByRole("button", { name, exact: typeof name === "string" });
      await button.hover();
      const label = (await button.getAttribute("aria-label"))!;
      await expect(page.getByRole("tooltip")).toContainText(label);
      await page.mouse.move(700, 500);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    }

    // From the keyboard: Tab from Search and jump to All projects.
    const search = rail(page).getByRole("button", { name: "Search and jump" });
    await search.focus();
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("button", { name: "All projects" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("All projects");
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("tooltip")).toContainText("Search and jump");

    // On a Manage workstream, Hold all is a pause icon with a name and a note on what it does.
    await startWorkstream(page, "CA-401");
    await setManage(page);
    const hold = rail(page).getByRole("button", { name: "Hold all workstreams" });
    await expect(hold.locator("svg")).toHaveCount(1);
    await expect(hold).not.toContainText("⏸");
    await hold.hover();
    await expect(page.getByRole("tooltip")).toContainText("Hold all workstreams");
    await expect(page.getByRole("tooltip")).toContainText("Stops automatic steps in every workstream; agents carry on");
  });
});

test.describe("draft action bar", () => {
  // A draft card's action bar is pinned to the bottom of its card: at the peek's visible bottom while the card runs on below
  // it, flush with the card's own bottom once the card ends. Nothing of the card shows under it, and it is opaque and ruled
  // off, so the approve action reads as solid.

  test.use({ viewport: { width: 1440, height: 900 } });

  const box = async (l: Locator) => (await l.boundingBox())!;
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
    await expectFlushAtEnd(page, review, barOf(review, /^Post review/));

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
});

test.describe("workstream start", () => {
  test("a new workstream opens with one sentence and one action, with the commands behind the '?' button", async ({ page }) => {
    await openApp(page);
    await agentsSettled(page);
    await startWorkstream(page, "CA-401");
    const pane = pipPane(page);

    // One short sentence on what the workstream is for, and no commands in it.
    const intro = pane.locator("[data-empty-workstream]");
    await expect(intro).toHaveText(/^Everything for CA-401 .+ stays here: its agents, drafts and our conversation\.$/);
    const text = (await intro.textContent()) ?? "";
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
    await expect(pane.getByText("/stop R1")).toHaveCount(0);

    // The workstream's first suggestion is the intro's one primary action, not repeated as a chip.
    const primary = pane.getByRole("button", { name: "Investigate CA-401", exact: true });
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveAttribute("data-intro-action", "true");
    await expect(primary).toBeVisible();

    // The commands are a Tab away from the input, open with Enter and close with Esc, leaving the pane open.
    await page.locator(PIP_INPUT).focus();
    await page.keyboard.press("Tab");
    const help = pane.getByRole("button", { name: "Commands", exact: true });
    await expect(help).toBeFocused();
    await expect(help).toHaveText("?");
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    const dialog = pane.getByRole("dialog", { name: "Commands" });
    await expect(dialog).toBeVisible();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    for (const usage of ["/stop R1", "/retry R1", "/answer R1 your answer", "/hold", "/resume"]) await expect(dialog.getByText(usage, { exact: true })).toBeVisible();
    await expect(dialog).toContainText("R1 is a run in this workstream; a run's id works anywhere.");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(pane).toBeVisible();
    await expect(help).toBeFocused();
    // Space opens it as well.
    await page.keyboard.press(" ");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(pane).toBeVisible();

    // The primary action asks Pip what its chip would have asked.
    await primary.click();
    await expect(pane.locator("[data-user-bubble]").last()).toHaveText("Investigate CA-401");
    await expect(pane.locator("[data-empty-workstream]")).toHaveCount(0);
  });

  test("Pip home's Steps rail marks Investigate as next and keeps the later steps to one quiet line each", async ({ page }) => {
    await openApp(page);
    await agentsSettled(page);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);

    // The same intro and single action as in the pane.
    const region = homeConversationRegion(page);
    await expect(region.locator("[data-empty-workstream]")).toHaveText(/^Everything for CA-401 /);
    await expect(region.getByRole("button", { name: "Investigate CA-401", exact: true })).toHaveCount(1);
    await expect(region.getByRole("button", { name: "Commands", exact: true })).toBeVisible();

    const rail = stepRail(page);
    const next = rail.locator('[data-step-next="investigate"]');
    await expect(next).toBeVisible();
    await expect(next).toContainText("Not started");
    await expect(rail.locator("[data-step-next]")).toHaveCount(1);
    const quiet = rail.locator("[data-step-quiet]");
    await expect(quiet).toHaveCount(5);
    expect(await quiet.evaluateAll((els) => els.map((el) => el.getAttribute("data-step-chip")))).toEqual(["triage", "plan", "build", "review", "verify"]);
    for (const box of await quiet.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeLessThan(30);
    await expect(quiet.getByText("Not started")).toHaveCount(0);

    // A quiet step still opens.
    const plan = rail.locator('[data-step-chip="plan"]');
    await plan.click();
    await expect(plan).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator('[data-step="plan"]')).toContainText("Nothing here yet.");
  });
});

test.describe("plain words", () => {
  /**
   * No three-figure hour count anywhere the person can read. (That a held workstream never says "tripwire" is checked
   * where one is held for real, in basis-drift.spec.ts.)
   */
  async function plainWords(page: Page) {
    await expect(page.locator("body")).not.toContainText(/Quiet for \d{3,} h|\b\d{3,} h\b/);
  }

  test("the Agents view and Pip home say how long a run has been quiet in days, never in hundreds of hours", async ({ page }) => {
    // The sample runs' ages count back from when the page opened; ten days on, the working CA-377 run (quiet for 40 minutes
    // then) has been quiet for over 240 hours.
    await page.clock.install();
    await openApp(page);
    await agentsSettled(page);
    await page.clock.setSystemTime(Date.now() + 10 * 24 * 60 * 60_000);
    await page.getByRole("button", { name: /^Agents/ }).click();
    const quiet = page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)', { hasText: "CA-377" });
    await expect(quiet.first()).toContainText(/Quiet for \d+ days/);
    await plainWords(page);

    await openPipHome(page);
    await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
    await plainWords(page);
  });
});
