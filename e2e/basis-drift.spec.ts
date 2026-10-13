import { expect, test, type Page } from "@playwright/test";
import { askPip, editTicket, finishOnHome, homeConversation, homeRunCards, homeSettled, homeWakes, inlineStart, jiraWrites, mockRuns, needOfKind, needsYouRow, openApp, openPipHome, pipHome, startWorkstream, stepRail, workstreamEvents, workstreamRow } from "./support/app";

// New workstreams open in Manage, where the supervisor checks the ticket against the basis the workstream recorded.
const MANAGED = "runs=empty&wsManage=1";
const DESCRIPTION_HELD = "Held: the ticket's description changed in Jira";

/** Opens a workstream on `key` from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page, key: string) {
  await startWorkstream(page, key);
  await openPipHome(page);
  await workstreamRow(page, key).click();
  await expect(homeConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} .* · Intake$`));
}

const banner = (page: Page) => stepRail(page).locator("[data-held-banner]");
/** The machinery's name for a safety hold never reaches the screen, only what happened. */
const noTripwireText = async (page: Page) => expect(page.locator("body")).not.toContainText(/tripwire/i);
const driftedLines = async (page: Page) => (await workstreamEvents(page)).filter((e) => e.action === "basis_drifted").map((e) => e.detail);

test("a description edited in Jira holds the managed workstream and says why; Resume takes the ticket as it is, and Pip's next wake mentions it", async ({ page }) => {
  await openApp(page, MANAGED);
  await homeWorkstream(page, "CA-401");
  const row = workstreamRow(page, "CA-401");

  await editTicket(page, "CA-401", { description: "Someone rewrote the welcome flow: three emails, not two." });
  // The row, the Needs you tray and the rail all say why, and the rail says to read the ticket first.
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText(`· ${DESCRIPTION_HELD}`);
  await expect(needOfKind(page, "hold")).toContainText(DESCRIPTION_HELD);
  await expect(banner(page)).toHaveAttribute("data-held-banner", "tripwire:basis_drift");
  await expect(banner(page)).toContainText("Held: the ticket's description changed in Jira");
  await expect(banner(page).locator("[data-drift-hint]")).toContainText("Read CA-401 as it is now before you resume");
  await noTripwireText(page);
  await expect(banner(page)).toContainText("Automatic steps are paused. Resume turns them back on.");
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "false");
  expect(await driftedLines(page)).toEqual(["description"]);
  expect(await jiraWrites(page)).toEqual([]);

  // Resumed, it is managed again as it was before the hold, and works from the ticket as it reads now.
  await banner(page).getByRole("button", { name: "Resume" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "true");
  const actions = (await workstreamEvents(page)).map((e) => e.action);
  expect(actions.slice(actions.lastIndexOf("resumed"))).toContain("basis_captured");
  await expect(row.locator("[data-status]")).not.toHaveText("Needs you");

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
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  // The finished investigation waits to be read too, so the row counts the two; the hold's banner says why.
  await expect(row.locator("[data-status-detail]")).toHaveText("· 2 waiting");
  await expect(banner(page)).toHaveAttribute("data-held-banner", "tripwire:basis_drift");
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
  await expect(row.locator("[data-status]")).not.toHaveText("Needs you");

  await editTicket(page, "CA-402", { statusId: "Sent" });
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· Held: the ticket was moved to Done");
  await expect(needsYouRow(page, "CA-402")).toContainText("Held: the ticket was moved to Done");
  await expect(banner(page)).toContainText("Held: the ticket was moved to Done");
  await noTripwireText(page);
  expect(await driftedLines(page)).toEqual(["status"]);
  expect(await jiraWrites(page)).toEqual([]);
});
