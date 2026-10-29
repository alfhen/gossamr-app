import { expect, test, type Locator, type Page } from "@playwright/test";
import { askPip, homeConversation, homeConversationRegion, keepComments, mockRuns, openAgents, openApp, openPip, peekSheet, peekTicket, PIP_INPUT, pipIdle, pipPane, reviewedDraft, selectWorkstream, startWorkstream, stepRail } from "./support/app";

// The UX polish pass: what the person reads (no ids, tools or machinery words), where things sit (nothing covers
// anything), draft action bars, and how a new workstream opens.

test.describe("hidden machinery", () => {
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

test.describe("no overlap", () => {
  type Box = { x: number; y: number; width: number; height: number };

  const box = async (l: Locator): Promise<Box> => {
    const b = await l.boundingBox();
    if (!b) throw new Error("not on screen");
    return b;
  };

  const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;


  /** The left rail: the aside that holds the Workspace navigation (Rail.tsx). */
  const rail = (page: Page) => page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) });



  test("(e2) the last row of the list scrolls clear of the floating Pip button", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await expect(pipPane(page)).toHaveCount(0);
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher.getByRole("button", { name: /^Ask Pip/ })).toBeVisible();

    const list = page.getByRole("listbox", { name: "Items" });
    await list.evaluate((el) => {
      const scroller = el.parentElement!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    const last = list.getByRole("option").last();
    await expect(last).toBeInViewport();
    const row = await box(last);
    expect(intersects(row, await box(launcher.getByRole("button", { name: /^Ask Pip/ })))).toBe(false);
    // The assignee avatar at the row's end is in view, above the footer.
    const footer = await box(page.locator("main footer").first());
    expect(row.y + row.height).toBeLessThanOrEqual(footer.y + 1);
  });

  test("(e3) with the peek and the Pip pane open the canvas reflows beside the peek, tabs scrolling and badges uncut", async ({ page }) => {
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

    // Every tab is whole inside, and the ones that don't fit scroll in the strip, which stops left of the peek.
    for (const tab of await page.getByRole("tab").all()) {
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await tablist.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const inStrip = async () => {
      const [strip, tab] = [await box(tablist), await box(page.getByRole("tab", { selected: true }))];
      return tab.x >= strip.x - 1 && tab.x + tab.width <= strip.x + strip.width + 1;
    };
    // The view the person is in stayed on the strip as the peek and the pane opened.
    await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Everything/);
    await expect.poll(inStrip).toBe(true);
    // Choosing a tab from the keyboard brings the strip to it.
    await page.getByRole("tab", { name: /^Your turn/ }).click();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { selected: true })).not.toHaveText(/^Your turn/);
    await expect.poll(inStrip).toBe(true);

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

    for (const name of ["Search and jump", "All projects", /^Work/, "Settings", "Pip"]) {
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

test.describe("workstream start", () => {
  test("a new workstream opens with one sentence", async ({ page }) => {
    await openApp(page);
    await startWorkstream(page, "CA-401");
    const pane = pipPane(page);

    // One short sentence on what the workstream is for.
    const intro = pane.locator("[data-empty-workstream]");
    await expect(intro).toHaveText(/^Everything for CA-401 .+ stays here: its agents, drafts and our conversation\.$/);
    const text = (await intro.textContent()) ?? "";
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
    await expect(pane.getByText("/stop R1")).toHaveCount(0);
  });

  test("Pip home's Steps rail marks Investigate as next and keeps the later steps to one quiet line each", async ({ page }) => {
    await openApp(page);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);

    // The same intro as in the pane.
    const region = homeConversationRegion(page);
    await expect(region.locator("[data-empty-workstream]")).toHaveText(/^Everything for CA-401 /);

    const rail = stepRail(page);
    const next = rail.locator('[data-step-next="investigate"]');
    await expect(next).toBeVisible();
    await expect(next).toContainText("Not started");
    await expect(rail.locator("[data-step-next]")).toHaveCount(1);
    const quiet = rail.locator("[data-step-quiet]");
    await expect(quiet).toHaveCount(5);
    expect(await quiet.evaluateAll((els) => els.map((el) => el.getAttribute("data-step-chip")))).toEqual(["triage", "plan", "build", "review", "verify"]);
    for (const box of await quiet.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeLessThan(30);
    // Nothing visible says it; the state is there for a screen reader only (G34).
    await expect(quiet.locator("span:not(.sr-only)").getByText("Not started")).toHaveCount(0);
    await expect(quiet.locator(".sr-only")).toHaveText(Array(5).fill("Not started"));

    // A quiet step still opens.
    const plan = rail.locator('[data-step-chip="plan"]');
    await plan.click();
    await expect(plan).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator('[data-step="plan"]')).toContainText("Nothing here yet.");
  });
});

