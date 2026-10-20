import { expect, test, type Locator, type Page } from "@playwright/test";
import { agentsHome, commentOnTicket, editTicket, expectToast, jiraWrites, needsPane, openAgents, openApp, pipPane, selectWorkstream, startMyDay, startWorkstream, workstreamGroup } from "./support/app";

// The polish backlog of the sixth dogfood round: Plan my week asks reporters about unclear tickets (at most one pick) and
// shows several matches to choose from, a workstream closed on a ticket that is not Done is "closed, not done" and can be
// reopened, toasts take Esc and F6, the workstream list keeps the open workstream under a status filter, an idle pill says
// "may be unclear", the reporter's reply leaves a trace, and what Looks fine taught is said and can be given back by gap.

const port = Number(process.env.E2E_PORT ?? 4173);
const prefs = (extra: Record<string, unknown> = {}) => ({ cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true, ...extra }) }] }] });
/** The seeded profile without Start my day set aside, so its card shows. */
const DAY_DUE = prefs();
/** A profile that said Looks fine to every gap in CA often enough to stop being told. */
const LEARNED = prefs({ clarityLearning: { CA: { short: 3, done: 3, scope: 3, who: 3 } } });

const CLEAR = "The checkout total must show the discount, only for valid codes. The support team is waiting on it. Done when the total and the order e-mail agree.";
const plan = (page: Page) => agentsHome(page).locator("[data-plan-my-week]");
const picks = (page: Page) => plan(page).locator("[data-plan-pick]");
const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");



/** Opens Plan my week from Start my day's card. */
async function openPlan(page: Page) {
  await openAgents(page);
  await startMyDay(page);
  await agentsHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
  await expect(plan(page)).toBeVisible();
}

/** Takes every pick out of the plan, so what is added is all there is. */
async function clearPicks(page: Page) {
  while (await picks(page).count()) await picks(page).first().locator("[data-plan-remove]").click();
  await expect(plan(page).locator("[data-plan-empty]")).toBeVisible();
}

test.describe("Plan my week (G15, G24, G26)", () => {
  test.use({ storageState: DAY_DUE });

  test("proposes at most one unclear ticket, as asking the reporter, each pick with a line of its own", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    for (const key of ["CA-209", "WEB-108"]) await editTicket(page, key, { description: CLEAR });
    await openPlan(page);
    await expect(picks(page)).toHaveCount(3);
    const titles = await plan(page).locator("[data-plan-title]").allTextContents();
    expect(titles.filter((t) => /^Clarify \S+ with the reporter$/.test(t))).toHaveLength(1);
    expect(titles.filter((t) => /^(CA-209|WEB-108) /.test(t))).toHaveLength(2);
    const because = await plan(page).locator("[data-plan-because]").allTextContents();
    expect(new Set(because).size).toBe(because.length);
    const clarify = plan(page).locator("[data-plan-pick]", { hasText: "Clarify" });
    await expect(clarify.locator("[data-plan-because]")).toContainText("ask the reporter");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("the arrow keys and j k move between the rows, and stop at the ends", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPlan(page);
    await expect(picks(page)).toHaveCount(3);
    await picks(page).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(picks(page).nth(1)).toBeFocused();
    await page.keyboard.press("j");
    await expect(picks(page).nth(2)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(picks(page).nth(2)).toBeFocused();
    await page.keyboard.press("k");
    await expect(picks(page).nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(picks(page).first()).toBeFocused();
    // Alt+arrow still moves the row itself.
    const first = (await picks(page).first().getAttribute("data-plan-pick"))!;
    await page.keyboard.press("Alt+ArrowDown");
    await expect(picks(page).nth(1)).toHaveAttribute("data-plan-pick", first);
  });

  test("words that match several tickets show a short list to choose from, the person's own first, instead of picking one", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    await clearPicks(page);
    const add = plan(page).locator("[data-plan-add]");
    await add.fill("swatch");
    await plan(page).locator("[data-plan-add-go]").click();
    const choices = plan(page).locator("[data-plan-choices]");
    await expect(choices).toBeVisible();
    await expect(picks(page)).toHaveCount(0);
    const buttons = choices.locator("[data-plan-choice]");
    expect(await buttons.count()).toBeGreaterThanOrEqual(3);
    expect(await buttons.count()).toBeLessThanOrEqual(5);
    // The keyboard is on the first, which is assigned to the person.
    await expect(buttons.first()).toBeFocused();
    await expect(buttons.first()).toHaveAttribute("data-plan-choice", "WEB-101");
    await expect(buttons.first()).toContainText("assigned to you");
    await page.keyboard.press("ArrowDown");
    await expect(buttons.nth(1)).toBeFocused();
    // Esc cancels the list and nothing else: the card stays and the keyboard goes back to the field.
    await page.keyboard.press("Escape");
    await expect(choices).toHaveCount(0);
    await expect(plan(page)).toBeVisible();
    await expect(add).toBeFocused();
    await expect(picks(page)).toHaveCount(0);
    // Choosing one adds that one.
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(buttons.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(choices).toHaveCount(0);
    await expect(picks(page)).toHaveCount(1);
    await expect(plan(page).locator("[data-plan-added]")).toContainText("Added ");
    // A key is never a list.
    await add.fill("CA-208");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(choices).toHaveCount(0);
    await expect(picks(page)).toHaveCount(2);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("toasts from the keyboard (G22)", () => {
  test.use({ storageState: DAY_DUE });

  test("F6 reaches the toast on screen, Esc dismisses it and gives the keyboard back", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPlan(page);
    await plan(page).getByRole("button", { name: "Keep this plan" }).click();
    const toast = page.locator("[data-toast]");
    await expect(toast).toContainText("Kept your plan");
    const onToast = () => page.evaluate(() => !!document.activeElement?.closest("[data-toast]"));
    // F6 goes round the regions; the toast is one of them while it shows.
    for (let n = 0; n < 9 && !(await onToast()); n++) await page.keyboard.press("F6");
    expect(await onToast()).toBe(true);
    await expect(toast).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toast).toHaveCount(0);
    // The keyboard is not lost to the page itself.
    expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);
  });
});

test.describe("the workstream list (G17, G21)", () => {
  test("an idle workstream whose ticket may be unclear says so in the pill's detail, and stays Idle (a notice is no need)", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    const row = workstreamGroup(page, "CA-408");
    await expect(row.locator("[data-status]")).toHaveText("Idle");
    await expect(row.locator("[data-status-detail]")).toHaveText("· may be unclear");
    await expect(agentsHome(page).locator("[data-needs-you-count]")).toHaveText("0");
  });

});

test.describe("the reporter's reply (G16)", () => {
  test("leaves a line in the timeline and the notice says the reporter replied", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await notice(agentsHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", "CA-408"]]);
    await expect(agentsHome(page).locator("[data-next-step]")).toContainText("Waiting on the reporter since");
    await expect(pipPane(page).locator("[data-timeline]")).not.toContainText("The reporter replied on the ticket");

    await commentOnTicket(page, "CA-408", "It should send three emails.");
    await expect(pipPane(page).locator("[data-timeline]")).toContainText("The reporter replied on the ticket");
    // The notice is back, but it doesn't repeat the gaps as if nothing was said.
    await expect(notice(agentsHome(page))).toContainText("CA-408: the reporter replied; read it, then Looks fine or ask again.");
    await expect(notice(agentsHome(page))).not.toContainText("may be unclear");
    expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  });
});

test.describe("what Looks fine taught (G19)", () => {
  test.use({ storageState: LEARNED });

  test("a workstream says quietly what it does not flag, and a single gap is given back from Settings", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    // Everything is taught away: no notice, but the note says so.
    await expect(notice(agentsHome(page))).toHaveCount(0);
    const quiet = agentsHome(page).locator("[data-clarity-quiet]");
    await expect(quiet).toContainText("Not flagged: you said Looks fine to");
    await expect(quiet).toContainText("in CA tickets");

    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    const learned = page.locator("[data-clarity-learning]");
    await expect(learned).toContainText("Say Looks fine to the same gap 3 times");
    await expect(learned.locator('[data-clarity-project="CA"] [data-clarity-gap]')).toHaveCount(4);
    await learned.getByRole("button", { name: "Give back short description in CA" }).click();
    await expectToast(page, "Gossamr will flag CA tickets with short description as before.");
    await expect(learned.locator('[data-clarity-project="CA"] [data-clarity-gap]')).toHaveCount(3);
    await expect(learned.locator('[data-clarity-gap="short"]')).toHaveCount(0);

    // That gap alone is flagged again on the workstream.
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await expect(notice(agentsHome(page))).toContainText("CA-408 may be unclear: it has a very short description.");
    await expect(agentsHome(page).locator("[data-clarity-quiet]")).toContainText("Not flagged: you said Looks fine to");
  });
});
