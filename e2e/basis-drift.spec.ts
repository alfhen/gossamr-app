import { expect, test, type Page } from "@playwright/test";
import { askPip, editTicket, finishOnHome, homeConversation, homeRunCards, homeSettled, homeWakes, inlineStart, jiraWrites, mockRuns, needsYouTray, openApp, openPipHome, pipHome, startWorkstream, stepRail, workstreamEvents, workstreamRow } from "./support/app";

// New workstreams open in Manage, where the supervisor checks the ticket against the basis the workstream recorded.
const MANAGED = "runs=empty&wsManage=1";
const DESCRIPTION_HELD = "Held: tripwire, the ticket's description changed in Jira";

/** Opens a workstream on `key` from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page, key: string) {
  await startWorkstream(page, key);
  await openPipHome(page);
  await workstreamRow(page, key).click();
  await expect(homeConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} .* · Intake$`));
}

const banner = (page: Page) => stepRail(page).locator("[data-held-banner]");
const driftedLines = async (page: Page) => (await workstreamEvents(page)).filter((e) => e.action === "basis_drifted").map((e) => e.detail);

test("a description edited in Jira holds the managed workstream and says why; Resume takes the ticket as it is, and Pip's next wake mentions it", async ({ page }) => {
  await openApp(page, MANAGED);
  await homeWorkstream(page, "CA-401");
  const row = workstreamRow(page, "CA-401");

  await editTicket(page, "CA-401", { description: "Someone rewrote the welcome flow: three emails, not two." });
  // The row, the Needs you tray and the rail all say why, and the rail says to read the ticket first.
  await expect(row.locator("[data-status]")).toHaveText(`· ${DESCRIPTION_HELD}`);
  await expect(needsYouTray(page).getByRole("button", { name: new RegExp(`^CA-401 · ${DESCRIPTION_HELD}`) })).toHaveCount(1);
  await expect(banner(page)).toHaveAttribute("data-held-banner", "tripwire:basis_drift");
  await expect(banner(page)).toContainText("Held: the ticket's description changed in Jira");
  await expect(banner(page).locator("[data-drift-hint]")).toContainText("Read CA-401 as it is now before you resume");
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "false");
  expect(await driftedLines(page)).toEqual(["description"]);
  expect(await jiraWrites(page)).toEqual([]);

  // Resumed and managed again, it works from the ticket as it reads now.
  await banner(page).getByRole("button", { name: "Resume" }).click();
  await expect(banner(page)).toHaveCount(0);
  await stepRail(page).getByRole("switch", { name: "Manage this workstream" }).click();
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "true");
  const actions = (await workstreamEvents(page)).map((e) => e.action);
  expect(actions.slice(actions.lastIndexOf("resumed"))).toContain("basis_captured");
  await expect(row.locator("[data-status]")).not.toContainText("Held");

  // A run finishes, and Pip's wake about it says once that the ticket changed while it was held.
  await askPip(page, "investigate this");
  await homeSettled(page);
  const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await review.getByRole("button", { name: "Start agent" }).click();
  await expect(review).toHaveCount(0);
  const id = (await mockRuns(page)).find((r) => r.kind === "investigate")!.id;
  await finishOnHome(page, id);
  await expect(homeWakes(page).last()).toContainText("The ticket's description changed while I was held; I'll work from it as it reads now.");
  expect(await driftedLines(page)).toEqual(["description"]);

  // The basis was taken again, so only a second edit holds it again, and once.
  await editTicket(page, "CA-401", { description: "And rewritten again." });
  await expect(row.locator("[data-status]")).toHaveText(`· ${DESCRIPTION_HELD}`);
  expect(await driftedLines(page)).toEqual(["description", "description"]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("moving a workstream's ticket to another status leaves it be; moving it to Done holds it, saying so", async ({ page }) => {
  await openApp(page, MANAGED);
  await homeWorkstream(page, "CA-402");
  const row = workstreamRow(page, "CA-402");

  // The sample CA workflow has no In Progress: QA is one of its statuses under way, and Sent its Done.
  await editTicket(page, "CA-402", { statusId: "QA" });
  // The backend's check runs inside the edit, so what it recorded is settled by now.
  expect(await driftedLines(page)).toEqual([]);
  expect((await workstreamEvents(page)).filter((e) => e.action === "tripwire")).toEqual([]);
  await expect(pipHome(page).getByRole("listbox", { name: "Workstreams" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(row.locator("[data-status]")).not.toContainText("Held");

  await editTicket(page, "CA-402", { statusId: "Sent" });
  await expect(row.locator("[data-status]")).toHaveText("· Held: tripwire, the ticket was moved to Done");
  await expect(needsYouTray(page).getByRole("button", { name: /^CA-402 · Held: tripwire, the ticket was moved to Done/ })).toHaveCount(1);
  await expect(banner(page)).toContainText("Held: the ticket was moved to Done");
  expect(await driftedLines(page)).toEqual(["status"]);
  expect(await jiraWrites(page)).toEqual([]);
});
