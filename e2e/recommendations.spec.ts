import { expect, test, type Locator, type Page } from "@playwright/test";
import { pauseAtCeiling, agentsHome, askPip, expandNeedsYou, groupByState, homeSettled, jiraWrites, keepComments, needRow, needsPane, needsYouCount, needsYouTray, openAgents, openApp, pipPane, selectWorkstream, startWorkstream, stepRail, openNeedOfKind, groupOpen, needsStack } from "./support/app";

// A few layout and keyboard scenarios of Pip home (docs/needs-you.md).

const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(pipPane(page).locator("[data-pip-conversation]")).toHaveText(/^Workstream: CA-401 /);
}

// Layout and explanations (dogfood B1, B4, B6): Needs you is Pip home's main left column and the screen is named; a
// decision shows once, in the pane, which scrolls alone and never hides text behind its action bar; Runs across every
// workstream stays in the timeline.

const home = (page: Page) => agentsHome(page);
const boxOf = async (loc: Locator) => (await loc.boundingBox())!;

test.describe("B4: a decision shows once", () => {
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
    // No scroller inside the pane but the pane, bar a long diff, which scrolls in a box of its own so the bar under it stays in view (round 10, G10).
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

// Keyboard and polish (dogfood B5, B7, B8, B11, B12): F6 reaches every region of Pip home and j/k treat every group alike;
// a command word outranks the tickets it also matches; one label for approving drafts together, whose preview opens in the
// pane; Ctrl+0 from a card's button; the launcher clear of Agents.


/** A workstream on CA-401 with two drafted comments of Pip's waiting in Needs you: one group of two needs, which may go together. */
async function twoDrafts(page: Page) {
  await openApp(page, SAMPLE);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await keepComments(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("2");
}

test.describe("B7: a command word outranks the tickets it also matches", () => {
  const options = async (page: Page, query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type(query);
    const list = page.getByRole("dialog", { name: "Command palette" }).getByRole("option");
    await expect(list.first()).toBeVisible();
    return list;
  };

  test("fuzzy ticket search still works, and a typed ticket key still leads", async ({ page }) => {
    await openApp(page, SAMPLE);
    let list = await options(page, "retry failed payment");
    await expect(list.first()).toContainText("DEVOPS-471");
    await page.keyboard.press("Escape");
    list = await options(page, "out of memory");
    await expect(list.first()).toContainText("DEVOPS-477");
    await page.keyboard.press("Escape");
    list = await options(page, "devops-471");
    await expect(list.first()).toContainText("DEVOPS-471");
  });
});

test.describe("B8: one label for approving drafts together, and its preview opens in the decision pane", () => {
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
    await expect(pane).toContainText("Nothing is posted until you choose.");
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

test.describe("B11: Ctrl+0 goes to Pip home from the Agents screen with a card's button focused", () => {
  test("from a card's own button, and from the card", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();

    await page.getByRole("button", { name: /^Agents/ }).click();
    const card = page.locator("main article[data-run-id]").first();
    await card.focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();
  });

  test("plain keys on a card's button still stay with the button", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await button.focus();
    await page.keyboard.press("j");
    await expect(button).toBeFocused();
  });
});

test.describe("B12: the Pip launcher keeps clear of the Agents screen's cards and its Earlier link", () => {
  test("no card and no lane link stands under the launcher, at the top of the list or the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    // A run the person stops goes under Earlier, folded, with its "Show" link at the lane's right end.
    await page.locator("main [data-run-id]").filter({ hasText: "WEB-108" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Agent run" });
    await sheet.getByRole("button", { name: "Stop", exact: true }).click();
    await sheet.getByRole("group", { name: "Stop this agent" }).getByRole("button", { name: "Yes, stop" }).dispatchEvent("click");
    await expect(sheet.locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    await groupByState(page);
    const show = page.locator('[data-lane="earlier"]').getByRole("button", { name: "Show" });
    await expect(show).toBeVisible();
    const scroller = page.locator("main [data-agents-list]").locator("xpath=..");
    const clear = async (what: string) => {
      const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
      const targets = [show, ...(await page.locator("main article[data-run-id]").all())];
      for (const t of targets) {
        const b = await boxOf(t);
        const over = b.x < l.x + l.width && b.x + b.width > l.x && b.y < l.y + l.height && b.y + b.height > l.y;
        expect(over, `${what}: something stands under the launcher`).toBe(false);
        // Left of its column outright, so no scroll position puts content under it.
        expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(l.x);
      }
    };
    await clear("top");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await clear("bottom");
    // The last row also ends above the launcher, with room.
    const last = await boxOf(show);
    const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
    expect(last.y + last.height).toBeLessThanOrEqual(l.y);
  });
});
