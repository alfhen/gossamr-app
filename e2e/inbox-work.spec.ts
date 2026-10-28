import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, closePipDrawer, expandNeedsYou, groupOpen, homeSettled, mockRuns, needOfKind, needRow, needsPane, needsStack, needsYouCount, openAgents, openApp, openNeedOfKind, pauseAtCeiling, selectWorkstream, startWorkstream, workstreamGroup, workstreamSheet } from "./support/app";

// The Inbox and Work screens (docs/simplification-proposal.md, 7.1): Inbox is one list of watched-ticket activity with one
// filter; Work is each workstream with its agents, one status word per workstream and one filter, Needs you.

const filter = (page: Page) => agentsHome(page).locator('[data-chip="needs"]');
const railWork = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Work(,|$)/ });

async function withNeeds(page: Page, calm = false) {
  await openApp(page);
  if (calm) await startWorkstream(page, "CA-402");
  await startWorkstream(page, "CA-401");
  // A pause is a need; the sample leaves CA-401's plan to approve and General's own needs.
  await pauseAtCeiling(page, "CA-401");
  await openAgents(page);
  await closePipDrawer(page);
}

test.describe("Work", () => {
  test("has one Needs you filter and no grouping, state or repo controls", async ({ page }) => {
    await withNeeds(page);
    const work = agentsHome(page);
    await expect(work.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
    await expect(work.getByRole("group", { name: "Show" }).getByRole("button")).toHaveCount(1);
    await expect(work.getByRole("group", { name: "Group by" })).toHaveCount(0);
    await expect(work.getByLabel("Filter by state")).toHaveCount(0);
    await expect(work.locator("select")).toHaveCount(0);
    await expect(work.locator("[data-lane]")).toHaveCount(0);
  });

  test("says one status word per workstream: Needs you for a paused one, and Idle for one with nothing going on", async ({ page }) => {
    await withNeeds(page, true);
    await expect(workstreamGroup(page, "CA-401").locator("[data-status]")).toHaveText("Needs you");
    await expect(workstreamGroup(page, "CA-402").locator("[data-status]")).toHaveText("Idle");
  });

  test("filters to what needs you with a count that is the rail badge's, and shows everything again when it is off", async ({ page }) => {
    await withNeeds(page, true);
    const count = Number(await needsYouCount(page).innerText());
    expect(count).toBeGreaterThan(1);
    await expect(railWork(page)).toHaveAccessibleName(`Work, ${count} things need you`);
    await expect(filter(page)).toHaveAttribute("aria-pressed", "false");
    await expect(workstreamGroup(page, "CA-402")).toBeVisible();

    await filter(page).click();
    await expect(filter(page)).toHaveAttribute("aria-pressed", "true");
    await expect(workstreamGroup(page, "CA-401")).toBeVisible();
    await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toBeVisible();
    await expect(workstreamGroup(page, "CA-402")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText(String(count));

    await filter(page).click();
    await expect(filter(page)).toHaveAttribute("aria-pressed", "false");
    await expect(workstreamGroup(page, "CA-402")).toBeVisible();
  });

  test("marks a workstream that has needs with a badge and an accent, and a calm one without", async ({ page }) => {
    await withNeeds(page, true);
    const busy = workstreamGroup(page, "CA-401");
    await expect(busy).toHaveAttribute("data-has-needs", "");
    await expect(busy.locator("[data-needs-you-badge]")).toContainText(/\d+ needs? you|\d+ need you/);
    const calm = workstreamGroup(page, "CA-402");
    await expect(calm).not.toHaveAttribute("data-has-needs", "");
    await expect(calm.locator("[data-needs-you-badge]")).toHaveCount(0);
    await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toHaveAttribute("data-has-needs", "");
  });

  test("opens a workstream with its needs at the top of the detail, most urgent first, the first one open", async ({ page }) => {
    await withNeeds(page);
    await groupOpen(page, "CA-401").click();
    const sheet = workstreamSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Needs you" })).toBeVisible();
    const items = needsStack(page).locator("[data-needs-pane]");
    expect(await items.count()).toBeGreaterThan(1);
    // A decision (the plan) outranks what is stuck (the pause).
    await expect(items.first()).toHaveAttribute("data-group", "decide");
    await expect(items.first()).toHaveAttribute("data-open", "true");
    await expect(items.nth(1)).toHaveAttribute("data-kind", "paused");
    await items.nth(1).locator("[data-need-key]").click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
    await expect(items.first()).not.toHaveAttribute("data-open", "true");
  });

  test("lists a need that belongs to no workstream under No workstream, reachable with the filter on", async ({ page }) => {
    await withNeeds(page);
    await filter(page).click();
    const none = agentsHome(page).locator('[data-workstream-group="none"]');
    await expect(none.locator("[data-needs-you-badge]")).toBeVisible();
    await groupOpen(page, "General").click();
    await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
    await expect(needsStack(page).locator("[data-needs-pane]").first()).toHaveAttribute("data-open", "true");
  });

  test("lists a failed agent, a Pip question and a pending draft under the Needs you filter", async ({ page }) => {
    await openApp(page, "runs=failures&prSurface=manual");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // The question last: Pip's next message would answer it.
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await askPip(page, "ask me which database to use");
    await homeSettled(page);
    await closePipDrawer(page);
    await filter(page).click();
    await expect(filter(page)).toHaveAttribute("aria-pressed", "true");

    await expect(workstreamGroup(page, "CA-401")).toBeVisible();
    await expandNeedsYou(page, "CA-401");
    await expect(needOfKind(page, "pipAsk")).toContainText("Which database to use?");
    await expect(needRow(page, /Draft comment/)).toHaveCount(1);

    await expandNeedsYou(page, "General");
    await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
    await expect(needOfKind(page, "failure")).toBeVisible();
  });

  test("opens from the rail's Needs you popover with the filter on and that need open", async ({ page }) => {
    await withNeeds(page);
    await expect(filter(page)).toHaveAttribute("aria-pressed", "false");
    await openNeedOfKind(page, "paused");
    await expect(filter(page)).toHaveAttribute("aria-pressed", "true");
    await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
    await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
  });

  test("has an agent row with its state and role, Open in Terminal and Stop, and opens the report from it", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const work = agentsHome(page);
    const row = work.locator('article[data-state="working"]').first();
    await expect(row).toBeVisible();
    await expect(row.locator("[data-role]")).toBeVisible();
    await expect(row.locator("span[data-state]").first()).toBeVisible();
    await expect(row.getByRole("button", { name: "Open in Terminal" })).toHaveCount(1);
    const done = work.locator('article[data-state="done"]').first();
    await expect(done.getByRole("button", { name: "Open in Terminal" })).toHaveCount(1);
    await done.click();
    await expect(page.locator("#agent-sheet [data-run-report]")).toBeVisible();
  });

  test("stops an agent from its row after one question", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const row = agentsHome(page).locator('article[data-state="working"]').first();
    const id = await row.getAttribute("data-run-id");
    await row.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(row.getByRole("group", { name: "Stop this agent" })).toBeVisible();
    await row.getByRole("button", { name: "Yes, stop" }).click();
    await expect(agentsHome(page).locator(`article[data-run-id="${id}"]`)).toHaveAttribute("data-state", "stopped");
  });

  test("walks the agents with j and k and opens one with Enter", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await expect(agentsHome(page).locator("article[data-run-id]").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#agent-sheet")).toBeVisible();
  });

  test("keeps an agent where it is while focus is in the list, and moves it once focus leaves", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const shownIds = () => agentsHome(page).locator("article[data-run-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")));
    const before = await shownIds();
    const working = (await mockRuns(page)).filter((r) => r.state === "working" && before.includes(r.id));
    const target = working.map((r) => r.id).sort((a, b) => before.indexOf(b)! - before.indexOf(a)!)[0];
    const other = before.find((id) => id !== target)!;
    await agentsHome(page).locator(`article[data-run-id="${other}"]`).focus();
    await expect(page.locator("[data-agents-list]")).toHaveAttribute("data-frozen", "true");
    await advanceRuns(page, 1, target);
    await expect(agentsHome(page).locator(`article[data-run-id="${target}"]`)).toHaveAttribute("data-state", "done");
    expect(await shownIds()).toEqual(before);
    await agentsHome(page).getByRole("button", { name: "Ask Pip", exact: true }).focus();
    await expect.poll(shownIds).not.toEqual(before);
    const after = await shownIds();
    expect([...after].sort()).toEqual([...before].sort());
    expect(after.indexOf(target)).toBeLessThan(before.indexOf(target));
  });

  test("keeps an agent where it is while the pointer is over the list, and moves it once the pointer leaves", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const shownIds = () => agentsHome(page).locator("article[data-run-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")));
    const before = await shownIds();
    const working = (await mockRuns(page)).filter((r) => r.state === "working" && before.includes(r.id));
    // The oldest working agent, so finishing it (the newest activity) lifts it to the top of its group.
    const target = working.map((r) => r.id).sort((a, b) => before.indexOf(b)! - before.indexOf(a)!)[0];
    const other = before.find((id) => id !== target)!;
    await agentsHome(page).locator(`article[data-run-id="${other}"]`).hover();
    await expect(page.locator("[data-agents-list]")).toHaveAttribute("data-frozen", "true");
    await advanceRuns(page, 1, target);
    await expect(agentsHome(page).locator(`article[data-run-id="${target}"]`)).toHaveAttribute("data-state", "done");
    expect(await shownIds()).toEqual(before);
    await page.locator("main header").first().hover();
    await expect(page.locator("[data-agents-list]")).not.toHaveAttribute("data-frozen", "true");
    const after = await shownIds();
    expect([...after].sort()).toEqual([...before].sort());
    expect(after.indexOf(target)).toBeLessThan(before.indexOf(target));
  });
});

test.describe("Settings", () => {
  test("has one notifications setting, on or off, and no digest", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
    await page.keyboard.press("Enter");
    const safety = page.getByRole("dialog", { name: "Agent settings" });
    const notifications = safety.getByRole("checkbox", { name: "Notifications" });
    await expect(notifications).toBeChecked();
    await expect(safety.getByText(/digest/i)).toHaveCount(0);
    await notifications.uncheck();
    await expect(notifications).not.toBeChecked();
    await notifications.check();
    await expect(notifications).toBeChecked();
    await notifications.uncheck();
    await expect(notifications).not.toBeChecked();
    // Saved, not only drawn: closing the dialog and opening it again reads the stored value.
    await page.keyboard.press("Escape");
    await expect(safety).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Agent settings" }).getByRole("checkbox", { name: "Notifications" })).not.toBeChecked();
  });
});

test.describe("Inbox", () => {
  test("is one list of watched-ticket activity with one Mentions filter", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Inbox(,|$)/ }).click();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const feed = page.getByRole("feed", { name: "Inbox" });
    await expect(feed.locator("article").first()).toBeVisible();
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button")).toHaveCount(1);
    const all = await feed.locator("article").count();
    await show.getByRole("button", { name: "Mentions" }).click();
    await expect(show.getByRole("button", { name: "Mentions" })).toHaveAttribute("aria-pressed", "true");
    await expect(feed.locator("article").first()).toContainText("mentioned you on");
    expect(await feed.locator("article").count()).toBeLessThan(all);
    await show.getByRole("button", { name: "Mentions" }).click();
    await expect(feed.locator("article")).toHaveCount(all);
  });

  test("marks an entry read, and all of them", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Inbox(,|$)/ }).click();
    const feed = page.getByRole("feed", { name: "Inbox" });
    const unread = feed.locator('article[data-unread="true"]');
    const first = await unread.count();
    expect(first).toBeGreaterThan(1);
    await unread.first().getByRole("button", { name: "Mark read" }).click();
    await expect(unread).toHaveCount(first - 1);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(unread).toHaveCount(0);
  });
});
