import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  dismissAgentSafety,
  holdPip,
  homeSettled,
  inlineStart,
  jiraWrites,
  homeComposer,
  homeConversation,
  homeConversationRegion,
  mockRuns,
  needsYouTray,
  openApp,
  openPipHome,
  peekTicket,
  peekSheet,
  PIP_INPUT,
  pipHome,
  pipPane,
  startWorkstream,
  stepChip,
  stepRail,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

/** The rail's Pip home button. */
const homeButton = (page: Page) => page.getByRole("button", { name: "Pip home" });

/** Waits until the sample backend has said whether Agents are on: the rail's Agents button shows or goes. */
async function agentsSettled(page: Page, on: boolean) {
  await expect(page.getByRole("button", { name: /^Agents/ })).toHaveCount(on ? 1 : 0);
}

test("Cmd/Ctrl+0 opens Pip home on General, and Pip answers there while its filter waits on the workspace tab", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  await openPipHome(page);
  await expect(pipHome(page).getByRole("region", { name: "Conversation" })).toBeVisible();
  await expect(pipHome(page).getByRole("complementary", { name: "Steps" })).toBeVisible();
  await expect(workstreamRow(page, "General")).toHaveAttribute("aria-selected", "true");
  await expect(homeConversation(page)).toHaveText("General");
  await expect(homeButton(page)).toHaveAttribute("aria-current", "page");
  // One conversation on screen: the docked pane and its launcher stay away on Pip home.
  await expect(pipPane(page)).toHaveCount(0);
  await expect(page.locator(PIP_INPUT)).toHaveCount(1);

  await askPip(page, "Show stale tickets");
  await expect(pipHome(page).getByText("Show stale tickets", { exact: true }).last()).toBeVisible();
  await expect(pipHome(page).getByText("View updated")).toBeVisible();
  // Pip home stays: the filter is the workspace tab's, there for when the person goes back.
  await expect(pipHome(page)).toBeVisible();
  await expect(homeConversation(page)).toHaveText("General");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("Show List");
  await page.keyboard.press("Enter");
  await expect(pipHome(page)).toHaveCount(0);
  await expect(page.getByText("Pip filtered this view")).toBeVisible();
});

test("Cmd/Ctrl+0 stays put while the person types a comment in the peek or has the palette open", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  await peekTicket(page, "CA-401");
  const comment = peekSheet(page).locator("#peek-composer");
  await comment.fill("Half a thought");
  await comment.press("ControlOrMeta+0");
  // Typing: the route, the peek and the unsaved comment all stay.
  await expect(pipHome(page)).toHaveCount(0);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(comment).toHaveValue("Half a thought");

  await comment.blur();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("combobox", { name: "Search commands and tickets" });
  await expect(palette).toBeVisible();
  // The palette keeps the keyboard in its search field; with the keyboard taken out of it, the key still waits.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true }));
  });
  await expect(pipHome(page)).toHaveCount(0);
  await expect(palette).toBeVisible();
});

test("the rail's Pip home button opens it too, and Cmd/Ctrl+J there goes to its composer", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  await homeButton(page).click();
  await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
  await workstreamRow(page, "General").focus();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(homeComposer(page)).toBeFocused();
  await expect(pipPane(page)).toHaveCount(0);
});

test("selecting a workstream switches the conversation, its controls and the steps; General is one row away", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await expect(homeConversation(page)).toHaveText("General");
  await expect(pipHome(page).getByRole("switch", { name: "Manage this workstream" })).toHaveCount(0);

  const row = workstreamRow(page, "CA-401");
  await expect(row).toContainText("Intake");
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await expect(pipHome(page).getByRole("switch", { name: "Manage this workstream" })).toBeVisible();
  await expect(pipHome(page).getByRole("complementary", { name: "Steps" }).getByText("Pip's notes")).toBeVisible();

  // The keyboard moves along the list too.
  await row.focus();
  await page.keyboard.press("k");
  await expect(workstreamRow(page, "General")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(homeConversation(page)).toHaveText("General");
});

test("with Agents off there is no Pip home: no rail button, Cmd/Ctrl+0 does nothing and the workspace is the landing", async ({ page }) => {
  await openApp(page, "runs=empty&agents=off");
  await agentsSettled(page, false);
  await expect(homeButton(page)).toHaveCount(0);
  await page.locator("body").press("ControlOrMeta+0");
  await expect(pipHome(page)).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Items" })).toBeVisible();
});

test("a fresh profile lands on Pip home with Agents on, and on the workspace with them off; 'Start on Pip home' off lands on the workspace", async ({ page }) => {
  // Nothing saved yet: the defaults, with Agents off first.
  await page.goto("/?runs=empty&agents=off");
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await agentsSettled(page, false);
  await expect(pipHome(page)).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Items" })).toBeVisible();

  // Agents on: Pip home, on General.
  await page.goto("/?runs=empty");
  await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
  await expect(homeConversation(page)).toHaveText("General");
  // Going back to the workspace stays there: Pip home is where a load starts, once.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("Show List");
  await page.keyboard.press("Enter");
  await expect(pipHome(page)).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Items" })).toBeVisible();

  // The switch is on until the person turns it off; then a load opens on the workspace.
  await page.getByRole("button", { name: /^Agents/ }).click();
  await page.getByRole("button", { name: "Safety and settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Agents safety and settings" });
  const choice = sheet.getByRole("switch", { name: "Start on Pip home" });
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "false");

  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await agentsSettled(page, true);
  await expect(page.getByRole("listbox", { name: "Items" })).toBeVisible();
  await expect(pipHome(page)).toHaveCount(0);
});

test("Pip home's 'Start a workstream…' opens the palette asking for the ticket, and the one picked opens there", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  await openPipHome(page);
  await expect(pipHome(page).getByText("No workstreams yet.")).toBeVisible();
  await pipHome(page).getByRole("button", { name: "Start a workstream…" }).click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog.getByRole("combobox")).toHaveValue("start a workstream on ");
  await expect(dialog.getByRole("option", { name: /^Start a workstream on/ })).toHaveCount(0);
  await page.keyboard.type("CA-401");
  const option = dialog.getByRole("option", { name: /^Start a workstream on CA-401/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(dialog).toHaveCount(0);
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await expect(pipHome(page).getByText("No workstreams yet.")).toHaveCount(0);
});

// A workstream in Manage mode, with pull requests shown only when a test says: the setting the phase's scenarios share.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

/** An item's line without how long it has waited, which can tick over between two reads. */
const withoutAge = (line: string) => line.replace(/ · (?:now|\d+[mhd])$/, "");

/** Waits until Pip has finished answering on Pip home. */
const settled = homeSettled;

/** Starts a workstream on `key` from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page, key = "CA-401") {
  await startWorkstream(page, key);
  await openPipHome(page);
  await workstreamRow(page, key).click();
  await expect(homeConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} `));
}

test("Needs you: Pip's investigation draft waits in the tray and on its row, goes to its card, and leaves once skipped", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  const row = workstreamRow(page, "CA-401");
  await expect(row.locator("[data-needs-you-badge]")).toHaveCount(0);

  await askPip(page, "investigate this");
  await settled(page);
  const item = needsYouTray(page).getByRole("button", { name: /^CA-401 · Start Investigate · / });
  await expect(item).toHaveCount(1);
  await expect(row.locator("[data-needs-you-badge]")).toHaveText("1 needs you");

  // From General, the item selects the workstream again and focuses the draft's card.
  await workstreamRow(page, "General").click();
  await expect(homeConversation(page)).toHaveText("General");
  await item.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  const card = pipHome(page).getByRole("region", { name: "Conversation" }).getByRole("article", { name: "Start an agent: CA-401" }).last();
  await expect(card).toBeFocused();

  // Skipped from its card's keys, it leaves the tray and the badge.
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(item).toHaveCount(0);
  await expect(row.locator("[data-needs-you-badge]")).toHaveCount(0);
});

test("Needs you: holding the workstream adds 'Held by you', its item goes to Resume, and Resume clears it", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  const row = workstreamRow(page, "CA-401");
  const held = needsYouTray(page).getByRole("button", { name: "CA-401 · Held by you" });
  await expect(held).toHaveCount(0);

  await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
  await expect(held).toHaveCount(1);
  await expect(row.locator("[data-status]")).toHaveText("· Held by you");
  await expect(row.locator("[data-needs-you-badge]")).toHaveText("1 needs you");

  await workstreamRow(page, "General").click();
  await held.click();
  const resume = pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" });
  await expect(resume).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(held).toHaveCount(0);
  await expect(row.locator("[data-needs-you-badge]")).toHaveCount(0);
});

test("Needs you from the board: the rail's Pip home popover lists the same items and jumps to them on Pip home", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  await askPip(page, "investigate this");
  await settled(page);
  await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
  const onHome = await needsYouTray(page).locator("[data-needs-you-item]").allTextContents();
  expect(onHome.some((t) => t.startsWith("CA-401 · Start Investigate"))).toBe(true);
  expect(onHome).toContain("CA-401 · Held by you");

  // Back on the board, the Pip home button counts them, and its menu shows the same list.
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(pipHome(page)).toHaveCount(0);
  const button = homeButton(page);
  await expect(button).toHaveAccessibleName(`Pip home, ${onHome.length} ${onHome.length === 1 ? "needs" : "need"} you`);
  await button.click({ button: "right" });
  const popover = page.getByRole("dialog", { name: "Needs you" });
  await expect(popover.locator("[data-needs-you-item]")).toHaveCount(onHome.length);
  expect((await popover.locator("[data-needs-you-item]").allTextContents()).map(withoutAge)).toEqual(onHome.map(withoutAge));

  // Esc closes it and leaves the board as it was.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(pipHome(page)).toHaveCount(0);

  // From the keyboard too: Shift+F10 on the focused button, as its description says.
  await expect(button).toHaveAttribute("aria-description", /Shift\+F10/);
  await expect(button).not.toHaveAttribute("aria-haspopup");
  await page.keyboard.press("Shift+F10");
  await expect(popover.locator("[data-needs-you-item]")).toHaveCount(onHome.length);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  await button.click({ button: "right" });
  await popover.getByRole("button", { name: /^CA-401 · Start Investigate/ }).click();
  await expect(popover).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
  await expect(pipHome(page).getByRole("region", { name: "Conversation" }).getByRole("article", { name: "Start an agent: CA-401" }).last()).toBeFocused();
});

/** Runs a palette command: opens the palette, types `query` and picks the entry named `name`. */
async function palette(page: Page, query: string, name: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill(query);
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("the palette opens Pip home, and 'Ask Pip to plan CA-401' lands on its workstream with a Plan draft and nothing started", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await palette(page, "pip home", "Open Pip home ⌘0");
  await expect(homeConversation(page)).toHaveText("General");

  await palette(page, "plan ca-401", /^Ask Pip to plan CA-401/);
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await expect(homeConversationRegion(page).getByText("plan CA-401", { exact: true })).toBeVisible();
  await settled(page);
  await expect(homeConversationRegion(page)).toContainText("I drafted a plan of CA-401");
  await expect(homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" })).toHaveCount(1);
  await expect(stepChip(page, "plan").locator("[data-step-needs-you]")).toHaveText("1 needs you");
  expect(await mockRuns(page)).toEqual([]);

  // From General, the palette finds the workstream again by its key.
  await workstreamRow(page, "General").click();
  await palette(page, "ca-401", "Open the workstream on CA-401 Pip home");
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
});

test("the peek's 'Open on Pip home' opens the ticket's workstream there, with the peek closed", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await startWorkstream(page, "CA-401");
  await peekSheet(page).getByRole("button", { name: "Open on Pip home" }).click();
  await expect(pipHome(page)).toBeVisible();
  await expect(peekSheet(page)).toHaveCount(0);
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
});

test("Esc on Pip home closes the setup sheet first, and only the next Esc stops Pip's answer", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await openPipHome(page);
  await holdPip(page, true);
  await askPip(page, "Catch me up");
  const stop = pipHome(page).getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();

  const setup = page.getByRole("dialog", { name: "Start an agent" });
  for (let attempt = 0; attempt < 2 && !(await setup.isVisible()); attempt++) {
    await palette(page, "investigate ca-401", /^Investigate CA-401/);
    await dismissAgentSafety(page);
  }
  await expect(setup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(setup).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();
  await expect(stop).toBeVisible();

  await homeComposer(page).focus();
  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0);
  await expect(homeConversationRegion(page).getByText("Set aside").or(homeConversationRegion(page).getByText("Stopped"))).toHaveCount(1);
  await holdPip(page, false);
  expect(await mockRuns(page)).toEqual([]);
});

test("Esc on a draft card asking for Enter cancels the ask and leaves Pip answering; the next Esc stops Pip", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  await askPip(page, "investigate this");
  await settled(page);
  const card = homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" }).last();
  await expect(card).toHaveCount(1);

  await holdPip(page, true);
  await askPip(page, "Catch me up");
  const stop = pipHome(page).getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await homeComposer(page).press("ArrowUp");
  await expect(card).toBeFocused();
  await page.keyboard.press("s");
  await expect(card.getByRole("status")).toHaveText(/^↵ skip/);
  await page.keyboard.press("Escape");
  await expect(card.getByRole("status")).not.toHaveText(/^↵ skip/);
  await expect(card).toHaveAttribute("data-state", "pending");
  await expect(stop).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0);
  await holdPip(page, false);
  await expect(card).toHaveAttribute("data-state", "pending");
});

test("a review opened with Enter on its card starts with one click on Start, or with Cmd/Ctrl+Enter on the card itself", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  await askPip(page, "investigate this");
  await settled(page);
  const card = homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" }).last();
  const refocus = async () => {
    await homeComposer(page).press("ArrowUp");
    await expect(card).toBeFocused();
  };
  await refocus();
  // From the keyboard, then one click: the card's hint goes only once the click is over, so Start doesn't move under it.
  const review = await inlineStart(page, card, "keyboard", refocus);
  const start = review.getByRole("button", { name: "Start agent" });
  await expect(start).toBeEnabled();
  await expect(card.locator(':scope > p[role="status"]')).toBeVisible();
  await start.click();
  await expect.poll(async () => (await mockRuns(page)).length).toBe(1);
  await expect(review).toHaveCount(0);

  // A second draft: Enter opens its review and the focus stays on the card, where Cmd/Ctrl+Enter starts it.
  await askPip(page, "investigate this");
  await settled(page);
  const next = homeConversationRegion(page).locator('article[data-draft][data-state="pending"]').last();
  await homeComposer(page).press("ArrowUp");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  const second = next.getByRole("group", { name: "Review and start" });
  await expect(second.getByRole("button", { name: "Start agent" })).toBeEnabled();
  await expect(next).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await mockRuns(page)).length).toBe(2);
});

test("a wake turn is compact, names its run as a button that opens it on the rail, and runs moving touch only the rail and the footer", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  const footer = homeConversationRegion(page).locator("[data-composer-footer]");
  await expect(footer).toHaveText("No agents working · nothing needs you");

  await askPip(page, "Investigate CA-401");
  await settled(page);
  await expect(footer).toHaveText("No agents working · 1 needs you");
  const card = homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" }).last();
  const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.getByRole("button", { name: "Review and start", exact: true }).click();
    await expect(card.getByRole("group", { name: "Review and start" }).or(safety)).toBeVisible();
    if (!(await safety.isVisible())) break;
    await dismissAgentSafety(page);
  }
  await card.getByRole("group", { name: "Review and start" }).getByRole("button", { name: "Start agent" }).click();
  // Waiting its turn is not working yet: the footer says queued.
  await expect(footer).toHaveText("No agents working · 1 queued · nothing needs you");

  const turns = homeConversationRegion(page).locator("[data-turn-kind]");
  const before = await turns.count();
  const r1 = (await mockRuns(page)).find((r) => r.kind === "investigate")!;
  // Launching and working: the rail and the footer follow; the conversation doesn't.
  await advanceRuns(page, 2, r1.id);
  await expect(stepChip(page, "investigate").locator("[data-step-state]")).toHaveText("Working");
  await expect(footer).toHaveText("1 agent working · nothing needs you");
  await expect(turns).toHaveCount(before);

  await advanceRuns(page, 1, r1.id);
  const wake = homeConversationRegion(page).locator('[data-turn-kind="wake"]');
  await expect(wake).toHaveCount(1);
  await expect(wake.locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  await expect(wake.locator(".bg-ws-accent")).toHaveCount(0);
  // Triage starts by the rule, queued until it launches; the footer counts it.
  await expect(stepChip(page, "triage").locator("[data-step-auto]")).toBeVisible();
  await expect(footer).toHaveText(/^No agents working · 1 queued · /);

  await wake.getByRole("button", { name: "run R1" }).click();
  const railCard = stepChip(page, "investigate").locator(`article[data-run-id="${r1.id}"]`);
  await expect(railCard).toBeVisible();
  await expect(railCard).toBeFocused();
  await expect(pipHome(page)).toBeVisible();
});

test("Activity's 'Pip & agents' chip lists the workstream's audit, and a row opens the workstream on Pip home", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  await askPip(page, "investigate this");
  await settled(page);
  const card = homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" }).last();
  const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.getByRole("button", { name: "Review and start", exact: true }).click();
    await expect(card.getByRole("group", { name: "Review and start" }).or(safety)).toBeVisible();
    if (!(await safety.isVisible())) break;
    await dismissAgentSafety(page);
  }
  await card.getByRole("group", { name: "Review and start" }).getByRole("button", { name: "Start agent" }).click();
  const r1 = (await mockRuns(page)).find((r) => r.kind === "investigate")!;
  await advanceRuns(page, 3, r1.id);
  await expect.poll(async () => (await workstreamEvents(page)).some((e) => e.action === "autostart")).toBe(true);

  await palette(page, "open activity", /^Open activity/);
  const chip = page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Pip & agents/ });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const feed = page.getByRole("feed", { name: "Activity" });
  await expect(feed.locator('article[data-source="pip"][data-action="opened"]')).toContainText("You opened the workstream");
  await expect(feed.locator('article[data-source="pip"][data-action="autostart"]')).toContainText("Triage R2 started automatically after R1");
  await expect(feed.locator('article[data-source="pip"][data-action="wake"]')).toContainText("Pip picked up R1");
  await expect(feed.locator("article:not([data-source='pip'])")).toHaveCount(0);

  await feed.locator('article[data-source="pip"][data-action="opened"]').getByRole("button").first().click();
  await expect(pipHome(page)).toBeVisible();
  await expect(workstreamRow(page, "CA-401")).toHaveAttribute("aria-selected", "true");
});

test("with Agents off, Activity has no 'Pip & agents' chip", async ({ page }) => {
  await openApp(page, "runs=empty&agents=off");
  await agentsSettled(page, false);
  await palette(page, "open activity", /^Open activity/);
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Pip & agents/ })).toHaveCount(0);
});

test("the rail's 'Approve these 2' approves Pip's two comments and never the description update beside them, which still opens its diff", async ({ page }) => {
  await openApp(page, "runs=empty");
  await agentsSettled(page, true);
  // Pip's drafts in the workstream's conversation, from the pane beside CA-401's peek: two comments and a description update.
  await startWorkstream(page, "CA-401");
  const pane = pipPane(page);
  for (const [ask, drafts] of [
    ["Draft a comment on this one", 1],
    ["Draft another comment on this one", 2],
    ["Draft a description update", 3],
  ] as const) {
    await askPip(page, ask);
    await expect(pane.locator('article[data-draft][data-state="pending"]')).toHaveCount(drafts);
  }
  await expect(pane.getByRole("article", { name: "Update the description of CA-401" })).toHaveCount(1);

  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  const section = stepRail(page).getByRole("region", { name: "Pip's drafts" });
  const rewrite = section.getByRole("article", { name: "Update the description of CA-401" });
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await section.getByRole("button", { name: "Approve these 2" }).click();
  await section.getByRole("button", { name: "Yes, approve 2" }).click();
  await expect(section.locator("[data-batch-outcome]")).toHaveText("Approved 2.");
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await expect(section.getByRole("button", { name: /^Approve these/ })).toHaveCount(0);

  // The update is read in its diff, in the peek, and approved only there.
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(peekSheet(page).getByRole("button", { name: "Update description" })).toBeVisible();
  expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
});
