import { expect, test, type Page } from "@playwright/test";
import {
  agentsHome,
  closeWorkstreamSheet,
  holdBySystem,
  needsPane,
  needsYouCount,
  needsYouRow,
  needsYouTray,
  openAgents,
  openApp,
  pipConversation,
  pipPane,
  selectWorkstream,
  startWorkstream,
  workstreamGroup,
  workstreamOpen,
  workstreamSheet,
} from "./support/app";

// Agents is the one work view (docs/needs-you.md): the Needs you strip at the top, every workstream with its agents under
// it, and a workstream's detail as a sheet beside the Pip drawer. There is no separate Pip home.

const MANAGED = "wsManage=1";

const agentsButton = (page: Page) => page.getByRole("button", { name: /^Agents/ });

test("the app opens on Agents, with Needs you at the very top and the workstreams grouped under it by default", async ({ page }) => {
  await page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}");
    delete prefs.startOnAgents;
    localStorage.setItem("gossamr-prefs", JSON.stringify(prefs));
  });
  await page.goto("/?" + MANAGED);
  await expect(agentsHome(page)).toBeVisible();
  await expect(page).toHaveTitle("Agents — Gossamr");
  // The strip is above the toolbar and the list; the grouping is Workstream, not State.
  const strip = needsYouTray(page);
  await expect(strip).toBeVisible();
  const above = await strip.evaluate((el) => el.compareDocumentPosition(document.querySelector('[role="group"][aria-label="Group by"]')!) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(above).toBeTruthy();
  await expect(page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Workstream" })).toHaveAttribute("aria-pressed", "true");
  await expect(agentsHome(page).locator("[data-lane]")).toHaveCount(0);
  await expect(agentsHome(page).locator("[data-workstream-group]").first()).toBeVisible();
});

test("there is no Pip home: no rail button, no ⌘0, no palette entry", async ({ page }) => {
  await openApp(page, MANAGED);
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
  await expect(palette.getByText("Open Agents", { exact: true })).toBeVisible();
});

test("the rail's one badge is the one count, on Agents", async ({ page }) => {
  await openApp(page, MANAGED);
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  const count = Number(await needsYouCount(page).innerText());
  expect(count).toBeGreaterThan(0);
  await expect(agentsButton(page)).toHaveAccessibleName(new RegExp(`^Agents, ${count} things? needs? you`));
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
});

test("a row of the strip opens its decision right under it, with the same buttons the card has", async ({ page }) => {
  await openApp(page, MANAGED);
  await openAgents(page);
  await expect(needsPane(page)).toHaveCount(0);
  const row = needsYouRow(page, "General").locator("[data-needs-you-group]");
  await row.click();
  const pane = needsPane(page);
  await expect(pane).toBeVisible();
  await expect(pane.locator("[data-needs-why]")).not.toBeEmpty();
  await expect(pane.locator("[data-needs-if-you-wait]")).toContainText("If you wait:");
  // The pane sits between the strip and the list.
  const order = await pane.evaluate((el) => {
    const strip = document.querySelector("[data-agents-strip]")!;
    const list = document.querySelector("[data-agents-list]")!;
    return [strip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, el.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING];
  });
  expect(order.every(Boolean)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
});

test("a run's 'In Needs you' pill opens the same decision, and nothing else changes screen", async ({ page }) => {
  await openApp(page, MANAGED);
  await openAgents(page);
  const pill = agentsHome(page).locator("[data-agents-list] article[data-run-id] button", { hasText: "In Needs you" }).first();
  await pill.click();
  await expect(needsPane(page)).toBeVisible();
  await expect(agentsHome(page)).toBeVisible();
});

test("a workstream is a group with its status and an Open button; its detail is a sheet that leaves the Pip drawer on the right", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  const group = workstreamGroup(page, "CA-401");
  await expect(group).toBeVisible();
  await expect(group.locator("[data-status]")).toBeVisible();
  await expect(group.locator("[data-stage]")).toHaveText("Intake");

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

test("Esc in the sheet puts it away, and leaving Agents does too", async ({ page }) => {
  await openApp(page, MANAGED);
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
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(workstreamSheet(page)).toHaveCount(0);
  await openAgents(page);
  await expect(workstreamSheet(page)).toHaveCount(0);
});

async function closePipDrawerIfOpen(page: Page) {
  if (await pipPane(page).count()) await pipPane(page).getByRole("button", { name: "Close Pip" }).click();
}

test("the palette's 'Open the workstream' and 'Show what needs me' land on Agents", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("open the workstream on CA-401");
  await palette.getByText("Open the workstream on CA-401", { exact: true }).first().click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

  await closeWorkstreamSheet(page);
  await page.getByRole("button", { name: "Activity" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByLabel("Search commands and tickets").fill("what needs me");
  await palette.getByText("Show what needs me", { exact: true }).click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(page.locator("[data-agents-strip] [data-needs-you-group]").first()).toBeFocused();
});

test("a need's 'Open in workstream' opens the workstream's detail with the card in it; a need outside any workstream opens Pip", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await holdBySystem(page, "CA-401", "restart");
  await openAgents(page);
  const ws = needsYouRow(page, "CA-401");
  await ws.locator("[data-needs-you-group]").click();
  await needsPane(page).getByRole("button", { name: "Open in workstream" }).click();
  await expect(needsPane(page)).toHaveCount(0);
  await expect(workstreamSheet(page)).toBeVisible();

  await closeWorkstreamSheet(page);
  await closePipDrawerIfOpen(page);
  await needsYouRow(page, "General").locator("[data-needs-you-group]").click();
  const pane = needsPane(page);
  const link = pane.locator("header").getByRole("button").first();
  await expect(link).toContainText(/Open the run|Show in Pip/);
});

test("Start a workstream… and Show closed are in the toolbar", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await page.getByRole("button", { name: "Start a workstream…" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette.getByLabel(/Start a workstream/)).toBeVisible();
  await expect(palette.getByText("Start a workstream on CA-401", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

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

test("Agents keeps the State grouping when it is chosen, and the choice is kept", async ({ page }) => {
  await openApp(page, MANAGED);
  await openAgents(page);
  const group = page.getByRole("group", { name: "Group by" });
  await group.getByRole("button", { name: "State" }).click();
  await expect(agentsHome(page).locator("[data-lane]").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await openAgents(page);
  await expect(page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "State" })).toHaveAttribute("aria-pressed", "true");
});
