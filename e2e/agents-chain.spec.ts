import { expect, test } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, expectPeekInPlace, homeConversation, homeConversationRegion, homeSettled, mockRuns, openAgents, openApp, peekSheet, selectWorkstream, startWorkstream, stepChip } from "./support/app";

// Pull requests are shown only when a test says: the setting the phase's scenarios share.
const SAMPLE = "runs=empty&prSurface=manual";

/** Starts a workstream on CA-401 from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Parameters<typeof startWorkstream>[0]) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
}

/** Asks Pip for `what` on Pip home and waits for its answer. */
async function ask(page: Parameters<typeof startWorkstream>[0], what: string) {
  await askPip(page, what);
  await expect(homeConversationRegion(page).getByText(what, { exact: true }).last()).toBeVisible();
  await homeSettled(page);
}

/** Moves run `id` on to done: queued, launching, working, done. */
async function finish(page: Parameters<typeof startWorkstream>[0], id: string) {
  await homeSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Parameters<typeof startWorkstream>[0], kind: string) => (await mockRuns(page)).find((r) => r.step === kind) ?? null;

test("asking Pip to investigate starts the agent: no review, and the rail shows R1 running", async ({ page }) => {
  await openApp(page, SAMPLE);
  await homeWorkstream(page);
  await ask(page, "investigate this");
  // Nothing opened, and the person is still on Pip home with the workstream selected.
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  await expect(agentsHome(page)).toBeVisible();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  const r1 = (await newest(page, "investigate"))!;
  expect(r1.state).toBe("queued");
  const chip = stepChip(page, "investigate");
  await expect(chip.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(chip.locator("[data-step-state]")).toHaveText("Queued");

  // Launching, then working: the chip follows it.
  await advanceRuns(page, 2, r1.id);
  await expect(chip.locator("[data-step-state]")).toHaveText("Working");
  await expect(chip).toHaveAttribute("data-state", "working");
  // Opened, the chip shows R1's card.
  await chip.getByRole("button", { expanded: false }).first().click();
  await expect(chip.locator(`article[data-run-id="${r1.id}"]`)).toBeVisible();
});

test("a build follows the approved plan once Pip is asked, and starts with nothing to review", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, SAMPLE);
  await homeWorkstream(page);

  await ask(page, "investigate this");
  await finish(page, (await newest(page, "investigate"))!.id);
  await ask(page, "plan this");
  await finish(page, (await newest(page, "plan"))!.id);
  await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Ready to review");

  // The plan's description draft opens the ticket's peek, where its diff is read and approved as anywhere.
  const rewrite = homeConversationRegion(page).getByRole("article", { name: "Update the description of CA-401" }).last();
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expectPeekInPlace(page);
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" }).getByRole("button", { name: "Approve" }).click();
  await expect(rewrite).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  await openAgents(page);
  await selectWorkstream(page, "CA-401");

  await ask(page, "build it");
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  const build = (await newest(page, "build"))!;
  expect(build.state).toBe("queued");
  await expect(stepChip(page, "build").locator('[data-run-label="R3"]')).toBeVisible();
});
