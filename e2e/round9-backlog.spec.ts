import { expect, test, type Locator, type Page } from "@playwright/test";
import { advanceRuns, askPip, editTicket, expectToast, holdBySystem, homeComposer, homeSettled, jiraWrites, mockRuns, needsPane, needOfKind, needRow, openApp, openPipHome, paneSettled, pipHome, pipPane, startWorkstream, workstreamRow } from "./support/app";

// Fixes from round 9's backlog: Plan my week and Start my day capped with a scroll of their own (G19), the plan's intro and the answers draft saying where they come from (G20), the keyboard odds and ends
// (G21), a hold the system made above the person's own (G22) and the pause quoting what tripped it (G23).

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const plan = (page: Page) => pipHome(page).locator("[data-plan-my-week]");
const picks = (page: Page) => plan(page).locator("[data-plan-pick]");

/** Opens Plan my week from Start my day's card. */
async function openPlan(page: Page) {
  await openPipHome(page);
  await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
  await expect(plan(page)).toBeVisible();
}

/** The questions to the reporter on `key`, drafted from its notice and left waiting in the decision pane. */
async function draftOn(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
  await openPipHome(page);
  await workstreamRow(page, key).click();
  await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
  return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
}

/** Where a box is on the page. */
const box = async (locator: Locator) => (await locator.boundingBox())!;

test.describe("Plan my week and Start my day keep room for the rest (G19)", () => {
  test.use({ storageState: DAY_DUE, viewport: { width: 1440, height: 900 } });

  test("the plan scrolls inside a box of its own, so the timeline keeps usable room, and Keep stays in reach", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    // Four rows, as the screenshot had.
    for (const key of ["CA-402", "WEB-108", "CA-403"]) {
      if ((await picks(page).count()) >= 4) break;
      await plan(page).locator("[data-plan-add]").fill(key);
      await plan(page).locator("[data-plan-add-go]").click();
    }
    await expect(picks(page)).toHaveCount(4);
    const day = pipHome(page).locator("[data-pip-home-day]");
    // Plan my week gets nearly half the window (G13), so its three picks show; a fourth makes it scroll.
    expect((await box(day)).height).toBeLessThanOrEqual(900 * 0.45 + 2);
    expect(await day.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // The timeline is not squeezed to a sliver, and Keep is inside the box without scrolling it.
    expect((await box(pipHome(page).locator("[data-timeline]"))).height).toBeGreaterThanOrEqual(150);
    const keep = await box(plan(page).locator("[data-plan-keep]"));
    const dayBox = await box(day);
    expect(keep.y).toBeGreaterThanOrEqual(dayBox.y);
    expect(keep.y + keep.height).toBeLessThanOrEqual(dayBox.y + dayBox.height + 1);
  });

  test("Start my day is capped the same way, and a long list of unclear tickets is a count with More", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    // Thin descriptions make tickets that may be unclear: enough of them for the line to be long.
    for (const key of ["CA-402", "CA-403", "CA-404", "CA-405", "WEB-108", "DEVOPS-471"]) await editTicket(page, key, { description: "Fix it." });
    await openPipHome(page);
    const card = pipHome(page).locator("[data-start-my-day]");
    await expect(card).toBeVisible();
    const day = pipHome(page).locator("[data-pip-home-day]");
    expect((await box(day)).height).toBeLessThanOrEqual(900 * 0.3 + 2);
    const unclear = card.locator('[data-day-line="unclear"]');
    await expect(unclear.locator("h3")).toContainText("may be unclear");
    const count = Number((await unclear.locator("h3").innerText()).match(/^(\d+)/)![1]);
    expect(count).toBeGreaterThan(3);
    await expect(unclear.locator("[data-day-entry]")).toHaveCount(0);
    const more = unclear.getByRole("button", { name: "More" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(unclear.locator("[data-day-entry]")).toHaveCount(count);
    await unclear.getByRole("button", { name: "Show fewer" }).click();
    await expect(unclear.locator("[data-day-entry]")).toHaveCount(0);
  });
});

test.describe("the plan's intro (G20)", () => {
  test.use({ storageState: DAY_DUE });

  test("says in one line that what waits on others is answered in Needs you, not planned", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    await expect(plan(page).locator("[data-plan-left-out]")).toHaveText("It proposes 3; more that needs you stays in Needs you, where it is answered rather than planned.");
    await expect(plan(page).locator("[data-plan-intro]")).toContainText("Nothing is written to Jira.");
  });
});

test.describe("the answers draft says which reply it came from (G20)", () => {
  /** Asks Pip for an investigation of `key` and starts it past the one-time safety sheet, as the person does. */
  async function startInvestigation(page: Page, key: string) {
    await paneSettled(page);
    await askPip(page, "investigate this");
    await paneSettled(page);
    const setup = page.getByRole("dialog", { name: "Start an agent" });
    const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
      await expect(setup.or(safety)).toBeVisible();
      if (!(await safety.isVisible())) break;
      await safety.getByRole("button", { name: "Close" }).click();
    }
    await setup.getByRole("button", { name: "Start agent" }).click();
    await expect(setup).toHaveCount(0);
  }
  const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
  async function finish(page: Page, id: string) {
    await paneSettled(page);
    for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  }

  test("on its card in the app only, never in the comment that goes to Jira", async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, "runs=empty&prSurface=manual&wsManage=1&pipPace=1");
    await startWorkstream(page, "CA-408");
    await startInvestigation(page, "CA-408");
    await finish(page, (await newest(page, "investigate"))!.id);
    await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
    await finish(page, (await newest(page, "triage"))!.id);
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(homeComposer(page)).toHaveValue(/My answers: $/);
    await page.keyboard.type("1. Done means all three emails send. 2. Only the CRM export. 3. The support team.");
    await page.keyboard.press("Enter");
    await homeSettled(page);
    await needRow(page, "Answers to the open questions").click();
    const card = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(card).toContainText("Open questions from triage, answered by the assignee:");
    const line = card.locator('[data-provenance="pip"]');
    await expect(line).toContainText("Drafted by Pip");
    await expect(line).toContainText("Drafted from your reply “1. Done means all three emails send.");
    // What is posted is the answers alone.
    await card.getByRole("button", { name: "Edit" }).click();
    const text = await card.locator("textarea").first().inputValue();
    expect(text).toContain("Open questions from triage, answered by the assignee:");
    expect(text).not.toMatch(/Drafted|your reply|Pip/);
    await card.getByRole("button", { name: "Done editing" }).click();
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the keyboard odds and ends (G21)", () => {
  test.use({ storageState: DAY_DUE });

  test("Delete and Backspace on a plan row remove it with an Undo that puts it back where it was", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    await expect(picks(page)).toHaveCount(3);
    const ids = await picks(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-plan-pick")));
    const title = await picks(page).nth(1).locator("[data-plan-title]").innerText();
    await picks(page).nth(1).focus();
    await page.keyboard.press("Delete");
    await expect(picks(page)).toHaveCount(2);
    await expect(toast(page)).toContainText(`Removed ${title} from the plan.`);
    // The keyboard stays in the plan, on the pick that took its place.
    await expect(plan(page).locator(`[data-plan-pick="${ids[2]}"]`)).toBeFocused();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(picks(page)).toHaveCount(3);
    expect(await picks(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-plan-pick")))).toEqual(ids);
    await expect(plan(page).locator(`[data-plan-pick="${ids[1]}"]`)).toBeFocused();
    await expectToast(page, `Put ${title} back in the plan.`);
    // Backspace is the same, and so is the Remove button.
    await page.keyboard.press("Backspace");
    await expect(picks(page)).toHaveCount(2);
    await expect(toast(page).getByRole("button", { name: "Undo" })).toBeVisible();
  });

  test("Esc on the toast gives the keyboard back to where it was in the plan, not to Ask Pip", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    const ids = await picks(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-plan-pick")));
    await picks(page).nth(1).focus();
    await page.keyboard.press("Delete");
    await expect(toast(page)).toBeVisible();
    const near = plan(page).locator(`[data-plan-pick="${ids[2]}"]`);
    await expect(near).toBeFocused();
    // F6 goes round the regions to the toast; the composer is the stop before it.
    for (let n = 0; n < 12 && !(await toast(page).evaluate((el) => el.contains(document.activeElement))); n++) await page.keyboard.press("F6");
    // The toast offers Undo, so F6 puts the keyboard on it (G12 of round 10).
    await expect(toast(page).getByRole("button", { name: "Undo" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toast(page)).toHaveCount(0);
    await expect(near).toBeFocused();
  });

  test("Tab after Keep this plan never lands on a control that is not shown", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    await plan(page).locator("[data-plan-keep]").click();
    await expect(pipHome(page).locator("[data-this-week]")).toBeVisible();
    for (let n = 0; n < 16; n++) {
      await page.keyboard.press("Tab");
      const shown = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return true;
        return el.getClientRects().length > 0 && !el.closest("[hidden], [inert]") && getComputedStyle(el).visibility !== "hidden" && !(el as HTMLButtonElement).disabled;
      });
      expect(shown, `Tab ${n + 1}`).toBe(true);
    }
  });

  test("Esc on the Close confirm keeps the keyboard on Close… with a toast up", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Hold", exact: true }).click();
    await expect(toast(page)).toContainText("Held CA-401.");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
  });
});

test.describe("the person's own hold under the system's (G22)", () => {
  test("a hold the system made sorts above Held by you, which is drawn quieter", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty&wsManage=0");
    // CA-401 first, so CA-402 is the newer of the two, as the store keeps them.
    await allProjects(page);
    await startWorkstream(page, "CA-401");
    await startWorkstream(page, "CA-402");
    await openPipHome(page);
    // The steps used up in Advise ask nothing, so this is a hold and no need; the person holds the other themselves.
    await holdBySystem(page, "CA-401", "budget");
    await workstreamRow(page, "CA-402").click();
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    const system = workstreamRow(page, "CA-401").locator("[data-status]");
    const mine = workstreamRow(page, "CA-402").locator("[data-status]");
    await expect(system).toHaveAttribute("data-status", "held");
    await expect(system).toHaveText("Held");
    await expect(mine).toHaveAttribute("data-status", "held");
    await expect(mine).toHaveText(/^Held by you/);
    const order = await pipHome(page).locator("[data-workstream-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-workstream-row")));
    const keys = await pipHome(page).locator("[data-workstream-row] b").allInnerTexts();
    expect(keys.indexOf("CA-401")).toBeLessThan(keys.indexOf("CA-402"));
    expect(order[0]).toBe("general");
    await expect(system).toHaveClass(/border-ws-warn/);
    await expect(mine).not.toHaveClass(/border-ws-warn/);
  });
});

test.describe("the pause names what tripped it (G23)", () => {
  test("a broad mention as written, a secret masked to its first two characters", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    const pause = draft.locator("[data-post-pause]");
    const base = await needsPane(page).locator("textarea").count();
    expect(base).toBe(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    const original = await text.inputValue();
    await text.fill(`${original}\n\ncc @Everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("Your edit mentions everyone");
    await expect(pause).toContainText("at “@Everyone”");
    await expect(pause).not.toContainText("hunter2");
    // Another edit takes the pause back; with only the password it quotes that, masked.
    await draft.getByRole("button", { name: "Keep editing" }).click();
    await text.fill(`${original}\n\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("looks like a password, key or token at “hu…”");
    await expect(pause).not.toContainText("hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});
