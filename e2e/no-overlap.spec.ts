import { expect, test, type Locator, type Page } from "@playwright/test";
import { PIP_INPUT, advanceRuns, holdAll, mockRuns, needsYouTray, openApp, openPip, openPipHome, peekSheet, peekTicket, pipPane, setManage, startWorkstream } from "./support/app";

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

  // On Pip home it is clear of the Needs you tray and the home composer too.
  await openPipHome(page);
  await expect(needsYouTray(page)).toBeVisible();
  await clearOf(page, [needsYouTray(page), page.locator(PIP_INPUT), page.locator("[data-pip-home-hints]")]);

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
  await page.getByRole("tab", { name: /^Needs me/ }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { selected: true })).not.toHaveText(/^Needs me/);
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
  for (const badge of [blocked.getByText("Needs you", { exact: true }), blocked.getByText("⛓ blocked", { exact: true })]) {
    await expect(badge).toBeVisible();
    const b = await box(badge);
    const cell = await box(blocked.locator("[data-row-badges]"));
    expect(b.y + b.height).toBeLessThanOrEqual(cell.y + cell.height + 1);
    expect(b.x + b.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
  }
  await expect(blocked.locator("[data-row-title]")).toHaveAttribute("title", /· Needs you · blocked/);
  for (const badge of await list.getByText(/^(⛓ blocked|Needs you)$/).all()) {
    const b = await box(badge);
    expect(b.x + b.width).toBeLessThanOrEqual((await peekLeft()) + 1);
  }
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
