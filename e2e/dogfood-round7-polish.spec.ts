import { expect, test, type Locator, type Page } from "@playwright/test";
import { askPip, commentOnTicket, expectToast, homeConversation, holdBySystem, homeSettled, jiraWrites, needsPane, needsYouRow, needsYouTray, openApp, openPipHome, peekSheet, peekTicket, pipHome, startWorkstream, workstreamRow } from "./support/app";

// The polish backlog of the seventh dogfood round: the reporter's reply is quoted and opens its comment, a reopened plan
// item says its workstream is closed, Looks fine names the gaps it counts, the Decide pane's Done line names its workstream
// and goes back to it, the safety sheet's "Cancelled" note goes when the sheet comes back, Keep this plan stays in reach,
// closed titles wrap, the quiet note says where Flag again applies, a wait says when it began, the clarity notice is an F6
// stop, and a second ask of the reporter is a line of its own.

const port = Number(process.env.E2E_PORT ?? 4173);
const prefs = (extra: Record<string, unknown> = {}) => ({ cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true, ...extra }) }] }] });
/** The seeded profile without Start my day set aside, so its card shows. */
const DAY_DUE = prefs();
/** A profile that said Looks fine to every gap in CA often enough to stop being told. */
const LEARNED = prefs({ clarityLearning: { CA: { short: 3, done: 3, scope: 3, who: 3 } } });

const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const plan = (page: Page) => pipHome(page).locator("[data-plan-my-week]");
const picks = (page: Page) => plan(page).locator("[data-plan-pick]");
const thisWeek = (page: Page) => pipHome(page).locator("[data-this-week]");
const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");
const timeline = (page: Page) => pipHome(page).locator("[data-timeline]");

async function openPlan(page: Page) {
  await openPipHome(page);
  await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
  await expect(plan(page)).toBeVisible();
}

/** Takes every pick out of the plan, so what is added is all there is. */
async function clearPicks(page: Page) {
  while (await picks(page).count()) await picks(page).first().locator("[data-plan-remove]").click();
  await expect(plan(page).locator("[data-plan-empty]")).toBeVisible();
}

/** Asks the reporter of CA-408 from its notice and posts the comment. */
async function askAndPost(page: Page, posted: number) {
  await notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
  await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
  await expect.poll(async () => (await jiraWrites(page)).filter((w) => w.type === "comment").length).toBe(posted);
}

test.describe("the reporter's questions and reply (G15, G24, G26, G29)", () => {
  test("a wait says when it began; the reply is quoted in the timeline and opens its comment; the notice is an F6 stop; a second ask is its own line", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await askAndPost(page, 1);
    // G24: "0d" told nothing; the row says when the reporter was asked.
    await expect(workstreamRow(page, "CA-408").locator("[data-status]")).toHaveText("Waiting on reporter");
    await expect(workstreamRow(page, "CA-408").locator("[data-status-detail]")).toHaveText("· asked today");

    await commentOnTicket(page, "CA-408", "It should send three emails.\nOne to the shopper, two to support.");
    const entry = timeline(page).locator("[data-timeline-line]", { hasText: "The reporter replied on the ticket" });
    // G15: the quote is in the timeline entry and the notice.
    await expect(entry.locator("[data-timeline-detail]")).toHaveText("“It should send three emails. One to the shopper, two to support.”");
    await expect(notice(pipHome(page)).locator("[data-clarity-reply]")).toHaveText("They wrote: “It should send three emails. One to the shopper, two to support.”");

    // G26: F6 stops on the notice, so Looks fine is not a long Tab away.
    const onNotice = () => page.evaluate(() => !!document.activeElement?.closest("[data-clarity-notice]"));
    for (let n = 0; n < 9 && !(await onNotice()); n++) await page.keyboard.press("F6");
    expect(await onNotice()).toBe(true);
    await expect(notice(pipHome(page)).getByRole("button", { name: "Ask the reporter now" })).toBeFocused();

    // G15: the entry opens the comment on the ticket.
    await entry.locator("[data-timeline-open='comment']").click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-408");
    const comment = peekSheet(page).locator("li[data-comment]", { hasText: "It should send three emails." });
    await expect(comment).toBeVisible();
    await expect(comment).toBeInViewport();
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();

    // G29: the second ask is a line of its own, not "(2 times)".
    await askAndPost(page, 2);
    await expect(timeline(page)).not.toContainText(/\(\d+ times\)/);
    const asks = timeline(page).locator("[data-timeline-line]").filter({ hasNotText: "The reporter replied" }).filter({ hasText: /reporter/i });
    await expect.poll(() => asks.count()).toBeGreaterThanOrEqual(2);
  });
});

test.describe("This week (G16, G22)", () => {
  test.use({ storageState: DAY_DUE });

  test("a reopened item says its workstream is closed and starts one again; a closed title wraps and is readable, and the section is capped", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-402");
    await openPlan(page);
    await clearPicks(page);
    await plan(page).locator("[data-plan-add]").fill("CA-402");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(picks(page)).toHaveCount(1);
    await plan(page).getByRole("button", { name: "Keep this plan" }).click();
    await expect(thisWeek(page).locator("[data-this-week-item]")).toHaveCount(1);

    await allProjects(page);
    await peekTicket(page, "CA-402");
    await peekSheet(page).getByRole("button", { name: "Close…" }).click();
    await peekSheet(page).getByRole("group", { name: "Close this workstream" }).getByRole("button", { name: "Close workstream" }).click();
    await openPipHome(page);
    const item = thisWeek(page).locator("[data-this-week-item]");
    await expect(item).toHaveAttribute("data-closed", "true");

    // G22: the closed title is not cut to one line and is not faded.
    const title = item.getByRole("button", { name: /^Closed, not done: CA-402/ });
    const style = await title.evaluate((el) => {
      const s = getComputedStyle(el);
      return { overflow: s.textOverflow, opacity: s.opacity, wrap: s.whiteSpace };
    });
    expect(style.overflow).not.toBe("ellipsis");
    expect(style.opacity).toBe("1");
    expect(style.wrap).not.toBe("nowrap");
    // The section keeps to a quarter of the column, so Workstreams keeps its room.
    const left = await pipHome(page).locator("[data-pip-home-left]").boundingBox();
    const section = await thisWeek(page).boundingBox();
    expect(section!.height).toBeLessThanOrEqual(left!.height * 0.25 + 1);

    // G16: reopening leaves the workstream closed, and the item says so.
    await item.locator("[data-this-week-reopen]").click();
    await expect(item).not.toHaveAttribute("data-closed", /.*/);
    await expect(item.locator("[data-this-week-stopped]")).toHaveText("workstream closed");
    await item.getByRole("button", { name: /^Start a workstream on CA-402/ }).click();
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-402 /);
    await expect(workstreamRow(page, "CA-402")).toBeVisible();
    await expect(item.locator("[data-this-week-stopped]")).toHaveCount(0);
  });

  test("Keep this plan stays in reach while a list of matching tickets is open (G21)", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 620 });
    await openApp(page, "runs=empty");
    await openPlan(page);
    await clearPicks(page);
    await plan(page).locator("[data-plan-add]").fill("swatch");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(plan(page).locator("[data-plan-choices]")).toBeVisible();
    const keep = plan(page).locator("[data-plan-keep]");
    const region = pipHome(page).locator("[data-pip-home-day]");
    const inside = async () => {
      const [k, r] = await Promise.all([keep.boundingBox(), region.boundingBox()]);
      return k!.y >= r!.y - 1 && k!.y + k!.height <= r!.y + r!.height + 1;
    };
    expect(await inside()).toBe(true);
    // Still there once the card is scrolled to its top.
    await region.evaluate((el) => (el.scrollTop = 0));
    expect(await inside()).toBe(true);
  });
});

test.describe("Looks fine (G17, G23)", () => {
  test("the counter toast names the gaps it counts", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await notice(pipHome(page)).getByRole("button", { name: "Looks fine" }).click();
    await expectToast(page, /^Noted for short description.*\. After 2 more Looks fine on CA tickets like this/);
  });

  test.describe("with it all taught", () => {
    test.use({ storageState: LEARNED });

    test("the quiet note's link says it resets the project's gaps, in a readable colour", async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page, "runs=empty");
      await startWorkstream(page, "CA-408");
      await openPipHome(page);
      await workstreamRow(page, "CA-408").click();
      const quiet = pipHome(page).locator("[data-clarity-quiet]");
      await expect(quiet.getByRole("button", { name: "Flag again in CA" })).toBeVisible();
      const color = (el: Locator) => el.evaluate((e) => getComputedStyle(e).color);
      // Darker than the faint grey the note used (ink3), which is what the page's quietest text still is.
      const faint = await pipHome(page).getByRole("heading", { name: "Workstreams" }).evaluate((e) => getComputedStyle(e).color);
      expect(await color(quiet)).not.toBe(faint);
    });
  });
});

test.describe("the Decide pane moves on (G19)", () => {
  test("the Done line names the workstream and goes back to it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await needsYouTray(page).locator("[data-needs-you-group], [data-needs-you-need]").filter({ hasText: /Pip drafted a comment/ }).first().click();
    await holdBySystem(page, "CA-401", "restart");
    await expect(needsYouRow(page, "CA-401")).toContainText("Held after a restart");
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    const line = page.locator("[data-needs-advanced]");
    await expect(line).toHaveText(/^Posted to Jira: Draft comment: “[^”]+” on CA-401\. Now: CA-401 · Held after a restart$/);
    await line.locator("[data-needs-advanced-back]").click();
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
    await expect(needsPane(page)).toHaveCount(0);
    await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
    await expect(workstreamRow(page, "CA-401")).toBeFocused();
  });
});

test.describe("the one-time safety sheet (G20)", () => {
  test("the 'Nothing was started' note is gone when the start comes back for the same thing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
    const setup = page.getByRole("dialog", { name: "Start an agent" });
    const investigate = async () => {
      await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    };
    await peekTicket(page, "CA-401");
    await investigate();
    await expect(safety).toBeVisible();
    await safety.getByRole("button", { name: "Close" }).click();
    await expectToast(page, "Cancelled: Investigate CA-401. Nothing was started.");
    await investigate();
    await expect(setup).toBeVisible();
    // Counted at once: the note would go by itself after a few seconds, so waiting for it to leave proves nothing.
    expect(await page.locator("[data-toast]").filter({ hasText: "Nothing was started" }).count()).toBe(0);
  });
});
