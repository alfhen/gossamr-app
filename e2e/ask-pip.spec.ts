import { expect, test } from "@playwright/test";
import { askPip, expandNeedsYou, homeConversation, homeConversationRegion, homeSettled, mockRuns, needsStack, needsYouCount, openAgents, openApp, selectWorkstream, startWorkstream } from "./support/app";

const SAMPLE = "runs=empty&prSurface=manual";

test("Ask Pip on a ticket starts an investigation agent, which shows on the Work screen", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await askPip(page, "investigate this");
  await homeSettled(page);

  const timeline = homeConversationRegion(page).locator("[data-timeline-entry]");
  await expect(timeline.filter({ hasText: /Investigator R1/ })).toHaveCount(1);
  const run = (await mockRuns(page)).find((r) => r.step === "investigate" && r.key === "CA-401");
  expect(run).toBeTruthy();
  await expect(page.locator(`main article[data-run-id="${run!.id}"]`).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText("0");
});

test("a question from Pip waits in Needs you and clears when it is answered in the conversation", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await askPip(page, "ask me which database to use");
  await homeSettled(page);

  await expect(needsYouCount(page)).toHaveText("1", { timeout: 15_000 });
  await expandNeedsYou(page, "CA-401");
  await expect(needsStack(page).locator("[data-needs-you-need-title]")).toHaveText(["Pip asks you"]);
  await expect(needsStack(page)).toContainText("Which database to use?");

  await askPip(page, "Postgres");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("0");
});

test("when Pip stops an agent the conversation says so", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await askPip(page, "investigate this");
  await homeSettled(page);
  await askPip(page, "stop R1");
  await homeSettled(page);

  await expect.poll(async () => (await mockRuns(page)).find((r) => r.step === "investigate")?.state).toBe("stopped");
  await expect(homeConversationRegion(page).locator("[data-timeline-entry]").filter({ hasText: "Pip stopped R1" })).toHaveCount(1);
});
