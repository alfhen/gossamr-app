import { expect, test, type Page } from "@playwright/test";
import { agentsHome, askPip, closeWorkstreamSheet, holdBySystem, homeConversation, homeConversationRegion, homeSettled, jiraWrites, mockRuns, needOfKind, needsPane, needsPaneHeading, needsYouCount, needsYouTray, openAgents, openApp, openNeedOfKind, openPip, pipPane, selectWorkstream, startWorkstream, stepChip, stepRail, workstreamGroup } from "./support/app";

/** The rail's Agents button. */
const homeButton = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Agents/ });

/** Waits until the sample backend has said whether Agents are on: the rail's Agents button shows or goes. */
async function agentsSettled(page: Page, on: boolean) {
  await expect(page.getByRole("button", { name: /^Agents/ })).toHaveCount(on ? 1 : 0);
}

// A workstream in Manage mode, with pull requests shown only when a test says: the setting the phase's scenarios share.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

/** An item's line without how long it has waited, which can tick over between two reads. */
const withoutAge = (line: string) => line.replace(/ · (?:now|\d+[mhd])$/, "");

/** Waits until Pip has finished answering on Pip home. */
const settled = homeSettled;

/** Starts a workstream on `key` from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page, key = "CA-401") {
  await startWorkstream(page, key);
  await openAgents(page);
  await selectWorkstream(page, key);
  await expect(homeConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} `));
}

test("Needs you: Pip's investigation draft waits in the list and on its row, opens its decision, and leaves once skipped", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  const row = workstreamGroup(page, "CA-401");
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);

  await askPip(page, "investigate this");
  await settled(page);
  const item = needOfKind(page, "runStart");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("drafted an Investigate agent for CA-401");
  await expect(item.locator("[data-needs-you-chip]")).toHaveText("Review");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");

  // From General, the need selects the workstream again and opens its decision, with the draft's own Skip.
  await closeWorkstreamSheet(page);
  await expect(homeConversation(page)).toHaveText("General");
  await openNeedOfKind(page, "runStart");
  await expect(needsPane(page)).toContainText("it starts only when you approve it.");
  await expect(needsPane(page)).toContainText("If you wait: Nothing starts until you approve it.");

  // Skipped there, it leaves the list and the badge, and the pane has nothing left to open.
  await needsPane(page).getByRole("button", { name: "Skip" }).click();
  await expect(item).toHaveCount(0);
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);
  await expect(needsPane(page)).toHaveCount(0);
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

test("Needs you: a hold the person chose is no need, so the header says 'Held by you' with Resume and nothing is counted; a restart's hold is a need that opens Resume", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  const row = workstreamGroup(page, "CA-401");
  const held = needOfKind(page, "hold");
  await expect(held).toHaveCount(0);

  await agentsHome(page).getByRole("button", { name: "Hold", exact: true }).click();
  const banner = pipPane(page).locator("[data-held-banner]");
  await expect(banner).toContainText("Held by you");
  await expect(banner).toContainText("You chose this, so the hold itself is not in Needs you.");
  await expect(held).toHaveCount(0);
  await expect(row.locator("[data-status]")).toHaveText("Held by you");
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
  await banner.getByRole("button", { name: "Resume" }).click();
  await expect(banner).toHaveCount(0);

  // A hold the system makes is a need, with Resume as its decision.
  await holdBySystem(page, "CA-401", "restart");
  await expect(held).toHaveCount(1);
  await expect(held).toContainText("Held after a restart");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· Held after a restart");
  await closeWorkstreamSheet(page);
  await openNeedOfKind(page, "hold");
  const resume = needsPane(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(held).toHaveCount(0);
  await expect(row.locator('[data-status="needs-you"]')).toHaveCount(0);
});

test("Needs you from the board: the rail's Agents popover lists the same rows and opens their decisions on Agents", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await homeWorkstream(page);
  await askPip(page, "investigate this");
  await settled(page);
  await holdBySystem(page, "CA-401", "restart");
  const total = Number(await needsYouCount(page).innerText());
  expect(total).toBe(2);

  // Back on the board, the Agents button counts them, and its menu shows the same list.
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await expect(agentsHome(page)).toHaveCount(0);
  const button = homeButton(page);
  await expect(button).toHaveAccessibleName(`Agents, ${total} things need you`);
  await button.click({ button: "right" });
  const popover = page.getByRole("dialog", { name: "Needs you" });
  await expect(popover.locator("[data-needs-you-count]")).toHaveText(String(total));
  await expect(popover.locator("[data-needs-you-group]")).toHaveCount(1);
  expect((await popover.locator("[data-needs-you-group]").allTextContents()).map(withoutAge)[0]).toContain("Held after a restart");

  // Esc closes it and leaves the board as it was.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(agentsHome(page)).toHaveCount(0);

  await button.click({ button: "right" });
  await popover.locator("[data-needs-you-group]").click();
  await expect(popover).toHaveCount(0);
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsPane(page)).toBeVisible();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
});

/** Runs a palette command: opens the palette, types `query` and picks the entry named `name`. */
async function palette(page: Page, query: string, name: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill(query);
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("the palette: 'Ask Pip to plan CA-401' lands on its workstream with a Plan draft and nothing started", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page, true);
  await openAgents(page);
  await openPip(page);
  await expect(homeConversation(page)).toHaveText("General");

  await palette(page, "plan ca-401", /^Ask Pip to plan CA-401/);
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await expect(homeConversationRegion(page).getByText("plan CA-401", { exact: true })).toBeVisible();
  await settled(page);
  await expect(homeConversationRegion(page)).toContainText("I drafted a plan of CA-401");
  await expect(homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" })).toHaveCount(1);
  await expect(stepChip(page, "plan").locator("[data-step-needs-you]")).toHaveText("1 needs you");
  expect(await mockRuns(page)).toEqual([]);

  // From General, the palette finds the workstream again by its key.
  await closeWorkstreamSheet(page);
  await palette(page, "ca-401", "Open the workstream on CA-401");
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
});

test("with Agents off, Activity has no 'Pip & agents' chip", async ({ page }) => {
  await openApp(page, "runs=empty&agents=off");
  await agentsSettled(page, false);
  await palette(page, "open activity", /^Open activity/);
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Pip & agents/ })).toHaveCount(0);
});

test("the rail's batch button approves Pip's two comments and never the description update beside them, which still opens its diff", async ({ page }) => {
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

  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  const section = stepRail(page).getByRole("region", { name: "Pip's drafts" });
  // The description update is a decision, so it is the one open at the top of the detail, and not repeated in the rail.
  const rewrite = needsPane(page).getByRole("article", { name: "Update the description of CA-401" });
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await section.getByRole("button", { name: "Approve 2 of Pip's drafts" }).click();
  await section.getByRole("button", { name: "Yes, approve 2" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
  await expect(rewrite).toHaveAttribute("data-state", "pending");
  await expect(section.getByRole("button", { name: /^Approve \d+ of / })).toHaveCount(0);

  // The update is read in its diff and approved only there.
  await expect(rewrite.getByRole("button", { name: /Update description/ }).first()).toBeVisible();
  expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
});
