import { expect, type Page, test } from "@playwright/test";
import {
  advanceRuns, agentsButton, agentsHome, allProjects, boxOf, closeWorkstreamSheet, groupOpen, mockRuns, needsChip,
  needsFilter, needsPane, needsPaneHeading, needsYouCount, needsYouTray, openAgents, openApp, openNeedOfKind,
  pauseAtCeiling, pipConversation, pipPane, selectWorkstream, startWorkstream, withNeeds, workstreamGroup,
  workstreamOpen, workstreamSheet,
} from "./support/app";

async function closePipDrawerIfOpen(page: Page) {
  if (await pipPane(page).count()) await pipPane(page).getByRole("button", { name: "Close Pip" }).click();
}

const railWork = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Work(,|$)/ });

test("the app opens on Work, with one Needs you filter in the header, off, and the workstreams listed", async ({ page }) => {
  await page.goto("/");
  await expect(agentsHome(page)).toBeVisible();
  await expect(page).toHaveTitle("Work — Gossamr");
  const chips = page.getByRole("group", { name: "Show" });
  await expect(chips.getByRole("button")).toHaveCount(1);
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "false");
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).not.toHaveText("0");
  await expect(agentsHome(page).locator("[data-lane]")).toHaveCount(0);
  await expect(agentsHome(page).locator("[data-workstream-group]").first()).toBeVisible();
});

test("there is no Pip home: no rail button, no ⌘0, no palette entry", async ({ page }) => {
  await openApp(page);
  await expect(agentsButton(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Pip home/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+0");
  await expect(agentsHome(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "List" }).first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("pip home");
  await expect(palette.getByText(/Pip home/)).toHaveCount(0);
  await palette.getByLabel("Search commands and tickets").fill("open agents");
  await expect(palette.getByText("Open Work", { exact: true })).toBeVisible();
});

test("the rail's one badge is the one count, on Work", async ({ page }) => {
  await openApp(page);
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  const count = Number(await needsYouCount(page).innerText());
  expect(count).toBeGreaterThan(0);
  await expect(agentsButton(page)).toHaveAccessibleName(new RegExp(`^Work, ${count} things? needs? you`));
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
});

test("a workstream's Open button opens its detail with the decision at the top, above its runs and steps", async ({ page }) => {
  await openApp(page);
  await openAgents(page);
  await expect(needsPane(page)).toHaveCount(0);
  await groupOpen(page, "General").click();
  const sheet = workstreamSheet(page);
  await expect(sheet).toHaveAttribute("aria-label", "No workstream");
  const pane = needsPane(page);
  await expect(pane).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(pane.locator("[data-needs-why]")).not.toBeEmpty();
  await expect(pane.locator("[data-needs-if-you-wait]")).toContainText("If you wait:");
  // The open need has the keyboard's attention only when a key or a link opened it; a click on the list leaves focus alone.
  await pane.focus();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(sheet).toBeVisible();
});

test("a run's 'In Needs you' pill opens the same decision, with the Needs you filter on, and nothing else changes screen", async ({ page }) => {
  await openApp(page);
  await openAgents(page);
  const pill = agentsHome(page).locator("[data-agents-list] article[data-run-id] button", { hasText: "In Needs you" }).first();
  await pill.click();
  await expect(needsPane(page)).toBeVisible();
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(agentsHome(page)).toBeVisible();
});

test("a workstream is a group with its status and an Open button; its detail is a sheet that leaves the Pip drawer on the right", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  const group = workstreamGroup(page, "CA-401");
  await expect(group).toBeVisible();
  await expect(group.locator("[data-status]")).toBeVisible();

  await selectWorkstream(page, "CA-401");
  const sheet = workstreamSheet(page);
  await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(sheet.locator("[data-step-rail]")).toBeVisible();
  await expect(sheet.locator("[data-workstream-controls]")).toBeVisible();
  await expect(group).toHaveAttribute("aria-current", "true");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

  // The sheet is in the main area, beside the drawer, not under it.
  await expect
    .poll(async () => {
      const [sheetBox, pipBox] = await Promise.all([sheet.boundingBox(), pipPane(page).boundingBox()]);
      return sheetBox!.x + sheetBox!.width - pipBox!.x;
    })
    .toBeLessThanOrEqual(1);

  // The keyboard is in the sheet, so Esc puts the sheet away and leaves Pip where it is.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(pipPane(page)).toBeVisible();
});

test("Esc in the sheet puts it away, and leaving Work does too", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await closePipDrawerIfOpen(page);
  await workstreamOpen(page, "CA-401").click();
  await expect(workstreamSheet(page)).toBeVisible();
  await workstreamSheet(page).focus();
  await page.keyboard.press("Escape");
  await expect(workstreamSheet(page)).toHaveCount(0);

  await workstreamOpen(page, "CA-401").click();
  await expect(workstreamSheet(page)).toBeVisible();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(workstreamSheet(page)).toHaveCount(0);
  await openAgents(page);
  await expect(workstreamSheet(page)).toHaveCount(0);
});

test("the rail popover's item turns the Needs you filter on and opens that workstream's detail with the need at the top; a need in no workstream opens No workstream", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await pauseAtCeiling(page, "CA-401");
  await openAgents(page);
  await closePipDrawerIfOpen(page);
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "false");
  await openNeedOfKind(page, "paused");
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
  await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
  await expect(needsPaneHeading(page)).toBeFocused();

  await closeWorkstreamSheet(page);
  await openNeedOfKind(page, "permission");
  await expect(workstreamSheet(page)).toHaveAttribute("aria-label", "No workstream");
  await expect(needsPane(page)).toHaveAttribute("data-kind", "permission");
  await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toHaveAttribute("aria-current", "true");
});

test("Show closed is in the toolbar", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await closePipDrawerIfOpen(page);
  await selectWorkstream(page, "CA-401");
  await workstreamSheet(page).getByRole("button", { name: "Close…" }).first().click();
  await workstreamSheet(page).getByRole("button", { name: "Close workstream" }).click();
  await expect(workstreamGroup(page, "CA-401")).toHaveCount(0);
  await page.getByRole("button", { name: "Show closed" }).click();
  const closed = page.locator('[data-closed-workstream]');
  await expect(closed).toHaveCount(1);
  await expect(closed).toContainText("CA-401");
  await closed.getByRole("button", { name: /^Reopen/ }).click();
  await expect(workstreamGroup(page, "CA-401")).toBeVisible();
});

test.describe("the rail's badge", () => {
  test("the rail's one badge names what it counts, in its tooltip and in its button's name, and Activity has none", async ({ page }) => {
    await openApp(page);
    const named = async (button: RegExp, badge: RegExp) => {
      const b = page.getByRole("button", { name: button });
      await expect(b).toBeVisible();
      const tip = b.locator("[title]").filter({ hasText: /^\d+\+?$/ });
      await expect(tip).toHaveAttribute("title", badge);
      return (await tip.getAttribute("title"))!;
    };
    await named(/^Work, \d+ things? needs? you$/, /^\d+ things? needs? you$/);
    // The bell is a link to Activity, with no number.
    const activity = page.getByRole("button", { name: "Inbox", exact: true });
    await expect(activity).toBeVisible();
    await expect(activity.locator("[title]")).toHaveCount(0);
  });
});

test.describe("opening Work", () => {
  test("puts the keyboard on the Work heading, not in Pip's composer", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Work" })).toBeFocused();
  });
});

test.describe("status words", () => {
  test("a row's pill and the header's pill carry what the word means", async ({ page }) => {
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    const pill = workstreamGroup(page, "CA-402").locator("[data-status]");
    await expect(pill).toHaveText("Idle");
    await expect(pill).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    // The same words are in the row as text for a screen reader, which the pill is described by.
    await expect(workstreamGroup(page, "CA-402").locator("[data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
    await expect(pill).toHaveAttribute("aria-describedby", /.+/);
    await selectWorkstream(page, "CA-402");
    await expect(pipPane(page).locator("[data-header-status]")).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    await expect(pipPane(page).locator("[data-header-status] [data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
  });
});

test.describe("an idle workstream", () => {
  test("an idle workstream is Idle with no detail, and asks nothing of the person", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    const row = workstreamGroup(page, "CA-408");
    await expect(row.locator("[data-status]")).toHaveText("Idle");
    await expect(row.locator("[data-status-detail]")).toHaveCount(0);
    await expect(agentsHome(page).locator("[data-needs-you-count]")).toHaveText("0");
  });
});

test.describe("Work's list", () => {
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
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "false");
    await expect(workstreamGroup(page, "CA-402")).toBeVisible();

    await needsFilter(page).click();
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "true");
    await expect(workstreamGroup(page, "CA-401")).toBeVisible();
    await expect(agentsHome(page).locator('[data-workstream-group="none"]')).toBeVisible();
    await expect(workstreamGroup(page, "CA-402")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText(String(count));

    await needsFilter(page).click();
    await expect(needsFilter(page)).toHaveAttribute("aria-pressed", "false");
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

test.describe("the Pip launcher keeps clear of the Work screen's cards", () => {
  test("no card stands under the launcher, at the top of the list or the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    const last = page.locator("main article[data-run-id]").last();
    const scroller = page.locator("main [data-agents-list]").locator("xpath=..");
    const clear = async (what: string) => {
      const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
      const targets = await page.locator("main article[data-run-id]").all();
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
    const lastBox = await boxOf(last);
    const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(l.y);
  });
});
