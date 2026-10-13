import { expect, test, type Page } from "@playwright/test";
import { expectToast, jiraWrites, openApp, openPipHome, peekSheet, peekTicket, pipHome, seedWorkstreamEvent, startWorkstream, workstreamRow } from "./support/app";

// One status word per workstream (its row and its header), searchable in the palette; and Plan my week: a deterministic
// proposal the person reorders, trims, adds to and keeps, shown as This week on Pip home. Nothing here writes to Jira.

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
const headerStatus = (page: Page) => pipHome(page).getByRole("region", { name: "Conversation" }).locator("[data-header-status] [data-status]");
const plan = (page: Page) => pipHome(page).locator("[data-plan-my-week]");
const picks = (page: Page) => plan(page).locator("[data-plan-pick]");
const thisWeek = (page: Page) => pipHome(page).locator("[data-this-week]");

async function runCommand(page: Page, query: string, option: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(query);
  await palette(page).getByRole("option", { name: option }).first().click();
  await expect(palette(page)).toHaveCount(0);
}

/** A workstream on ticket `key`, begun from its peek; leaves the workspace behind it. */
async function begin(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
}

/** CA-408 waits on the reporter: asked and posted `days` days ago, as the audit would say it. */
async function waitingOn(page: Page, days: number) {
  await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "clarity_asked", at: ago(days + 0.1), proposalId: "old-ask" });
  await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "draft_approved", at: ago(days), proposalId: "old-ask" });
}

test.describe("one status word per workstream", () => {
  test("the row and the header say the same word with at most one detail, and the palette narrows the list by it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await begin(page, "CA-402");
    await waitingOn(page, 3);
    await openPipHome(page);

    const waiting = workstreamRow(page, "CA-408");
    const idle = workstreamRow(page, "CA-402");
    await expect(waiting.locator("[data-status]")).toHaveText("Waiting on reporter");
    await expect(waiting.locator("[data-status-detail]")).toHaveText("· 3d");
    await expect(waiting.locator("[data-status]")).toHaveAttribute("data-status", "waiting");
    await expect(idle.locator("[data-status]")).toHaveText("Idle");
    await expect(idle.locator("[data-status-detail]")).toHaveCount(0);
    // One word per row, and the stage stays as it was.
    await expect(waiting.locator("[data-status]")).toHaveCount(1);
    await expect(waiting.locator("[data-stage]")).toHaveText("Intake");

    // The header of the workstream shown says the same word.
    await waiting.click();
    await expect(headerStatus(page)).toHaveText("Waiting on reporter");
    await idle.click();
    await expect(headerStatus(page)).toHaveText("Idle");

    // Held by you is the person's own word.
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(idle.locator("[data-status]")).toHaveText("Held by you");
    await expect(headerStatus(page)).toHaveText("Held by you");

    // ⌘K narrows the list to a status, and brings it all back.
    await runCommand(page, "show workstreams waiting on reporter", "Show workstreams waiting on reporter");
    await expect(pipHome(page).locator('[data-status-filter="waiting"]')).toContainText("Showing Waiting on reporter: 1");
    await expect(workstreamRow(page, "CA-408")).toBeVisible();
    await expect(workstreamRow(page, "CA-402")).toHaveCount(0);
    await runCommand(page, "show workstreams held", "Show held workstreams");
    await expect(workstreamRow(page, "CA-402")).toBeVisible();
    await expect(workstreamRow(page, "CA-408")).toHaveCount(0);
    await runCommand(page, "show all workstreams", "Show all workstreams");
    await expect(pipHome(page).locator("[data-status-filter]")).toHaveCount(0);
    await expect(workstreamRow(page, "CA-408")).toBeVisible();
    await expect(workstreamRow(page, "CA-402")).toBeVisible();
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("Plan my week", () => {
  test.use({ storageState: DAY_DUE });

  test("proposes three with a because each, skipping what waits; reorder by key, remove and add; keep it, and This week shows it after a reload and ticks it when the workstream closes", async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await begin(page, "CA-402");
    await waitingOn(page, 3);
    await openPipHome(page);
    await expect(thisWeek(page)).toHaveCount(0);

    // From the Start my day card.
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    await expect(plan(page)).toBeVisible();
    await expect(plan(page)).toBeFocused();
    await expect(plan(page)).toContainText("Nothing is written to Jira.");
    await expect(picks(page)).toHaveCount(3);
    // The open workstream first; the one waiting on the reporter is left out; each pick says why.
    await expect(picks(page).first()).toContainText("CA-402");
    await expect(plan(page)).not.toContainText("CA-408");
    for (const because of await plan(page).locator("[data-plan-because]").allTextContents()) expect(because).toMatch(/^Because .+\.$/);

    // Alt+↓ moves the focused row down, and the keyboard follows it.
    const first = (await picks(page).first().getAttribute("data-plan-pick"))!;
    await picks(page).first().focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(picks(page).nth(1)).toHaveAttribute("data-plan-pick", first);
    await expect(picks(page).nth(1)).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(picks(page).first()).toHaveAttribute("data-plan-pick", first);

    // Remove one, add one by key.
    const second = (await picks(page).nth(1).getAttribute("data-plan-pick"))!;
    await picks(page).nth(1).locator("[data-plan-remove]").click();
    await expect(picks(page)).toHaveCount(2);
    await expect(plan(page).locator(`[data-plan-pick="${second}"]`)).toHaveCount(0);
    await plan(page).locator("[data-plan-add]").fill("CA-999");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(plan(page).locator("[data-plan-missing]")).toBeVisible();
    await plan(page).locator("[data-plan-add]").fill("CA-208");
    await plan(page).locator("[data-plan-add-go]").click();
    await expect(picks(page)).toHaveCount(3);
    await expect(picks(page).last()).toContainText("CA-208");
    await expect(picks(page).last()).toContainText("Because you added it.");

    // Keep it: This week lists the three, the card goes, and nothing went to Jira.
    await plan(page).getByRole("button", { name: "Keep this plan" }).click();
    await expectToast(page, /Kept your plan for \d{4}-W\d{2}\. Nothing was sent to Jira\./);
    await expect(plan(page)).toHaveCount(0);
    await expect(thisWeek(page).locator("[data-this-week-item]")).toHaveCount(3);
    await expect(thisWeek(page)).toContainText("CA-402");
    await expect(thisWeek(page)).toContainText("CA-208");
    expect(await jiraWrites(page)).toEqual([]);
    const stored = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}").weekPlans ?? {}) as { week: string; items: { id: string }[] }[]);
    expect(stored).toHaveLength(1);
    expect(stored[0].week).toMatch(/^\d{4}-W\d{2}$/);
    expect(stored[0].items).toHaveLength(3);

    // It is still there after a reload, and the CA-402 item opens its workstream.
    await page.reload();
    await openPipHome(page);
    await expect(thisWeek(page).locator("[data-this-week-item]")).toHaveCount(3);
    await thisWeek(page).getByRole("button", { name: /^CA-402/ }).click();
    await expect(workstreamRow(page, "CA-402")).toHaveAttribute("aria-selected", "true");
    await expect(thisWeek(page).locator("[data-done]")).toHaveCount(0);

    // Closing the workstream ticks its item.
    await allProjects(page);
    await peekTicket(page, "CA-402");
    await peekSheet(page).getByRole("button", { name: "Close…" }).click();
    await peekSheet(page).getByRole("group", { name: "Close this workstream" }).getByRole("button", { name: "Close workstream" }).click();
    await openPipHome(page);
    await expect(thisWeek(page).locator("[data-done]")).toHaveCount(1);
    await expect(thisWeek(page).getByRole("button", { name: /^Done: CA-402/ })).toBeVisible();

    // ⌘K opens it again, with the kept plan to edit; nothing was written to Jira.
    await runCommand(page, "plan my week", "Plan my week");
    await expect(plan(page)).toBeFocused();
    await expect(picks(page)).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(plan(page)).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
  });
});
