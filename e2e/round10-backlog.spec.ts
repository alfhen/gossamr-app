import { expect, test, type Page } from "@playwright/test";
import { agentsHome, agentsSettled, closeWorkstreamSheet, editTicket, jiraWrites, needsPane, openAgents, openApp, selectWorkstream, startMyDay, startWorkstream, stepRail } from "./support/app";

// Fixes from round 10's backlog: the unclear tickets higher on Start my day (G26), the workstream controls on the steps rail's
// F6 stop (G27), Ctrl+0 on Pip home going on to General (G28), "N here" on a Needs you group (G30), the palette's and the
// reporter draft's notes (G31) and the toasts leaving with the page and clearing the launcher (G32).

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const THIN = "Fix it.";
const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const notice = (page: Page) => agentsHome(page).locator("[data-clarity-notice]");

/** A workstream on `key`, begun from its peek, and Pip home on it. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

test.describe("Start my day puts the unclear tickets above the lines that follow (G26)", () => {
  test.use({ storageState: DAY_DUE });

  test("the unclear line comes right after the lines that need a decision, before the drafts and the quiet ones", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    for (const key of ["CA-402", "CA-409"]) await editTicket(page, key, { description: THIN });
    await begin(page, "CA-402");
    await begin(page, "CA-409");
    await openAgents(page);
    await selectWorkstream(page, "CA-402");
    await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
    await page.keyboard.press("Escape");
    await closeWorkstreamSheet(page);
    await startMyDay(page);
    const card = agentsHome(page).locator("[data-start-my-day]");
    await expect(card).toBeVisible();
    const kinds = await card.locator("[data-day-line]").evaluateAll((els) => els.map((el) => el.getAttribute("data-day-line")));
    // The questions draft is a decision now, on the approve line only (round 13, G10), so the unclear line follows that one.
    expect(kinds).toContain("approve");
    const unclear = kinds.indexOf("unclear");
    expect(unclear, kinds.join()).toBeGreaterThan(kinds.indexOf("approve"));
    for (const later of ["drafts", "reporter", "cobweb"]) if (kinds.includes(later)) expect(unclear, kinds.join()).toBeLessThan(kinds.indexOf(later));
    expect(kinds.filter((k) => k === "unclear")).toHaveLength(1);
  });
});

test.describe("what the palette and the reporter draft say (G31)", () => {
  test("'Start a workstream' says it starts no agent and posts nothing", async ({ page }) => {
    await openApp(page, "runs=empty");
    await agentsSettled(page, true);
    await openAgents(page);
    await agentsHome(page).getByRole("button", { name: "Start a workstream…" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.locator("[data-palette-note]")).toHaveText("Opens a workstream; starts no agent and posts nothing.");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-palette-note]")).toHaveCount(0);
  });

  test("a question to a reporter that @mentions them says who it mentions; nothing is written before approval", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: THIN });
    await begin(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft).toBeVisible();
    await expect(draft).toContainText("@");
    await expect(draft.locator("[data-mention-note]")).toHaveText(/^Posts as you; Jira notifies .+\.$/);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("toasts leave with the page and clear the launcher (G32)", () => {
  test("one without Undo is dismissed when the route changes", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await begin(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const rail = stepRail(page);
    await rail.getByRole("button", { name: "Close…" }).click();
    await rail.getByRole("button", { name: "Close workstream" }).click();
    await expect(toast(page)).toContainText("Closed the workstream on CA-408");
    // Close has an Undo now (round 13, G23); the toast that says it was undone has none.
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Reopened the workstream on CA-408");
    await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    // A toast younger than the route grace (500 ms) is taken to come with the change and stays; leave it older than that.
    await page.waitForTimeout(700);
    await allProjects(page);
    await expect(agentsHome(page)).toHaveCount(0);
    await expect(toast(page)).toHaveCount(0);
  });

  test("on the workspace a toast stands above the Pip launcher, not over it", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    // A toast over the workspace (here, from drafting a ticket in the palette) clears the launcher's box.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("New ticket");
    await page.getByRole("option", { name: /^New ticket/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    if (await dialog.getByRole("option").count()) await dialog.getByRole("option").first().click();
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("Check the toast");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText("Drafted a new ticket");
    const t = (await toast(page).boundingBox())!;
    // Neither the launcher's box nor the thread its spider hangs from.
    const thread = (await launcher.locator(".pip-thread").boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual((await launcher.boundingBox())!.y);
    expect(t.y + t.height).toBeLessThanOrEqual(thread.y);
  });
});
