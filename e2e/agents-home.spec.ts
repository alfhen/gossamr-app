import { expect, test, type Page } from "@playwright/test";
import { agentsHome, closeWorkstreamSheet, pauseAtCeiling, needsChip, needsPane, needsPaneHeading, needsYouCount, needsYouTray, openNeedOfKind, openAgents, openApp, pipConversation, pipPane, selectWorkstream, startWorkstream, workstreamGroup, workstreamOpen, workstreamSheet, groupOpen } from "./support/app";

// Work is the one work screen (docs/needs-you.md): one filter (Needs you), every workstream with its agents under it,
// and a workstream's detail as a sheet beside the Pip drawer. There is no separate Pip home.

const agentsButton = (page: Page) => page.getByRole("button", { name: /^Work(,|$)/ });

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

async function closePipDrawerIfOpen(page: Page) {
  if (await pipPane(page).count()) await pipPane(page).getByRole("button", { name: "Close Pip" }).click();
}

test("the palette's 'Open the workstream' and 'Show what needs me' land on Work", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("open the workstream on CA-401");
  await palette.getByText("Open the workstream on CA-401", { exact: true }).first().click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

  await closeWorkstreamSheet(page);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByLabel("Search commands and tickets").fill("what needs me");
  await palette.getByText("Show what needs me", { exact: true }).click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(needsPaneHeading(page)).toBeFocused();
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

