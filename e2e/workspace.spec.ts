import { expect, type Locator, type Page, test } from "@playwright/test";
import { focusIn, openApp, openPip, peekSheet, peekTicket, PIP_INPUT, pipPane } from "./support/app";

const rail = (page: Page) => page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) });

test.describe("a ticket opened from the palette", () => {
  test("a ticket opened from Ctrl+K takes the keyboard into its peek, and Tab stays there", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("CA-402");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-402");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("Tab");
    expect(await focusIn(page, "#peek-sheet")).toBe(true);
    // A control of the peek's own, never the board's Filter input behind it.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
    // j and k from inside it step to the next ticket's peek, and the keyboard goes along rather than to the page.
    await peekSheet(page).locator("h2").first().focus();
    for (const step of ["j", "j", "k"]) {
      const before = await peekSheet(page).getAttribute("aria-label");
      await page.keyboard.press(step);
      await expect(peekSheet(page)).not.toHaveAttribute("aria-label", before!);
      await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    }
    // Esc closes it and the keyboard goes back to the board.
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });
});

test.describe("Esc and F6 across the list, the peek and Pip", () => {
  test("Esc in Pip's composer closes the peek over it first, then Pip", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-403");
    await openPip(page);
    const input = pipPane(page).locator(PIP_INPUT);
    await input.focus();
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await expect(pipPane(page)).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pipPane(page)).toHaveCount(0);
  });

  test("F6 steps between the list, the peek and Pip; Tab past the pane's last button goes on to the next region, never the page", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-403");
    await openPip(page);
    const input = pipPane(page).locator(PIP_INPUT);
    await input.focus();
    await page.keyboard.press("F6");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("workspace-main");
    await page.keyboard.press("F6");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("F6");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("Shift+F6");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("workspace-main");

    // Tab from the composer goes on to the next region rather than the page itself.
    await input.focus();
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? null, id: document.activeElement?.id ?? null }));
    expect(at.tag).not.toBe("BODY");
    expect(at.id).toBe("workspace-main");
  });
});

test.describe("the rail's names", () => {
  test("a rail button shows its name, and its shortcut, on hover and on keyboard focus", async ({ page }) => {
    await openApp(page, "runs=empty");
    const search = rail(page).getByRole("button", { name: "Search and jump" });
    await search.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/^Search and jump\s*⌘K$/);
    await page.mouse.move(700, 500);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await search.focus();
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("button", { name: "All projects" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("All projects");

    const settings = rail(page).getByRole("button", { name: "Settings" });
    await expect(settings).toHaveAttribute("aria-label", "Settings");
    await settings.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Settings");
  });

  test("only the hovered button's tooltip shows while another rail button has keyboard focus", async ({ page }) => {
    await openApp(page, "runs=empty");
    await rail(page).getByRole("button", { name: "Search and jump" }).focus();
    await page.keyboard.press("Tab");
    const focused = rail(page).getByRole("button", { name: "All projects" });
    await expect(focused).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("All projects");

    await rail(page).getByRole("button", { name: "Settings" }).hover();
    const tips = page.getByRole("tooltip");
    await expect(tips.filter({ visible: true })).toHaveCount(1);
    await expect(tips.filter({ visible: true })).toHaveText("Settings");

    // The pointer leaves the rail, and the keyboard's tooltip comes back.
    await page.mouse.move(700, 500);
    await expect(tips.filter({ visible: true })).toHaveText("All projects");
    await expect(tips.filter({ visible: true })).toHaveCount(1);
  });
});

test("the workspace loads with the sample tickets", async ({ page }) => {
  await openApp(page);
  const items = page.getByRole("listbox", { name: "Items" });
  await expect(items.getByRole("option").filter({ hasText: "CA-401" })).toContainText("Welcome flow refresh");
  expect(await items.getByRole("option").count()).toBeGreaterThan(1);
});

test("switching from list to board and back renders each view", async ({ page }) => {
  await openApp(page);
  const views = page.getByRole("group", { name: "View" });
  const items = page.getByRole("listbox", { name: "Items" });
  await expect(views.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await expect(items).toBeVisible();

  await views.getByRole("button", { name: "Board" }).click();
  await expect(views.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  await expect(items).toHaveCount(0);
  const boards = page.locator('section[aria-label$=" board"]');
  await expect(boards.first()).toBeVisible();
  await expect(boards.getByText("CA-401", { exact: true })).toBeVisible();

  await views.getByRole("button", { name: "List" }).click();
  await expect(boards).toHaveCount(0);
  await expect(items.getByText("CA-401", { exact: true })).toBeVisible();
});

test("clicking a ticket opens its peek, and Esc closes it", async ({ page }) => {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByRole("option").filter({ hasText: "CA-401" }).click();
  const peek = page.locator("#peek-sheet");
  await expect(peek).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(peek).toContainText("CA-401");
  await expect(peek).toContainText("Welcome flow refresh");

  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
});

test("Ctrl/Cmd+J opens Pip with its input focused, and closes it again", async ({ page }) => {
  await openApp(page);
  await expect(pipPane(page)).toHaveCount(0);
  await openPip(page);
  await expect(page.locator(PIP_INPUT)).toBeFocused();

  await page.keyboard.press("ControlOrMeta+j");
  await expect(pipPane(page)).toHaveCount(0);
});

test.describe("no overlap", () => {
  type Box = { x: number; y: number; width: number; height: number };

  const box = async (l: Locator): Promise<Box> => {
    const b = await l.boundingBox();
    if (!b) throw new Error("not on screen");
    return b;
  };

  const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test("the last row of the list scrolls clear of the floating Pip button", async ({ page }) => {
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

  test("with the peek and the Pip pane open the canvas reflows beside the peek, tabs scrolling and badges uncut", async ({ page }) => {
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

  test("a row too narrow for its badges in words shows each as an icon with its name and a tooltip, never drops one", async ({ page }) => {
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

  test("every rail button is named and shows its name on hover and on keyboard focus", async ({ page }) => {
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

test.describe("the rail's region", () => {
  test("the left rail is a named region", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("complementary", { name: "Workspace sidebar" })).toBeVisible();
  });
});
