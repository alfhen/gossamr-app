import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  expectToast,
  expandAllNeeds,
  mockRuns,
  needsYouCount,
  needsYouTray,
  openApp,
  openPipHome,
  pipPane,
  setBudget,
  startWorkstream,
  wakes,
  workstreamEvents,
} from "./support/app";

// The automatic step budget shown up front ("N of M automatic steps left", with a default that fits a whole chain), and a
// run Gossamr stopped at its limit: it needs the person, counted in Needs you, and only the person's Resume carries it on.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1";
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
const railButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();
const limitItems = (page: Page) => needsYouTray(page).locator('[data-needs-you-need][data-kind="stoppedAtLimit"]');

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for an investigation of CA-401, opens its draft past the one-time safety sheet and starts it, as the person does. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await settled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await runCards(page, "CA-401").last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** Moves run `id` on to done, once Pip has answered, so its finish gets a wake turn of its own. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

test("a managed workstream says how many automatic steps are left up front, from the default of 11, and counts each one down", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const left = pipPane(page).locator("[data-steps-left]");
  // The whole chain: investigate, triage, plan, build, review and verify is 6 steps whatever the fix rounds, which cost none, so 5 are spare.
  await expect(left).toHaveText("11 of 11 automatic steps left");
  await expect(pipPane(page).locator("[data-budget]")).toHaveCount(0);

  await startInvestigation(page);
  const investigation = (await mockRuns(page)).find((r) => r.kind === "investigate")!;
  await finish(page, investigation.id);
  await expect(wakes(page)).toHaveCount(1);
  await expect(left).toHaveText("10 of 11 automatic steps left");

  // A workstream's own limit counts, and is what it says.
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { autoTurns: 6 });
  await expect(left).toHaveText("5 of 6 automatic steps left");
});

test("a run stopped at its limit is in Needs you, with its pill in the Agents lane, and only Resume carries it on", async ({ page }) => {
  await openApp(page, "runs=stuck");
  const stopped = (await mockRuns(page)).find((r) => r.state === "stopped" && r.key === "CA-277");
  expect(stopped, "the stuck sample has a plan run stopped at its limit").toBeTruthy();
  const id = stopped!.id;

  // Pip home's Needs you counts it, as an item of its own.
  await openPipHome(page);
  await expandAllNeeds(page);
  await expect(limitItems(page)).toHaveCount(1);
  await expect(limitItems(page)).toContainText("stopped at its limit");
  const count = await needsYouCount(page).innerText();

  // The Agents view lists it under Failed or stuck with an "In Needs you" pill, and its header says the same one count.
  await railButton(page, /^Agents/).click();
  const lane = page.locator('[data-lane="bad"]');
  const card = lane.locator(`article[data-run-id="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Stopped at limit");
  await expect(card.locator("[data-in-needs-you]")).toBeVisible();
  const header = page.locator("main header").filter({ has: page.getByRole("heading", { name: "Agents" }) });
  await expect(railButton(page, /^Agents/)).toHaveAccessibleName("Agents");
  await expect(header).toContainText(`${count} need you`);

  // Nothing resumes it by itself: still stopped after the sample's supervisor and Pip have had their turns.
  await advanceRuns(page, 3);
  expect((await mockRuns(page)).find((r) => r.id === id)?.state).toBe("stopped");

  // Resume on its card is the person's click, through the same path as the sheet's.
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expectToast(page, "Resumed. Claude is picking it back up.");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
  // The lanes keep their order while the pointer is on one, so the card itself shows it carried on.
  const again = page.locator(`article[data-run-id="${id}"]`);
  await expect(again).toContainText("Working");
  await expect(again.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);

  // It no longer waits on the person, on Pip home either.
  await openPipHome(page);
  await expandAllNeeds(page);
  await expect(limitItems(page)).toHaveCount(0);
  // The sample's other runs moved meanwhile, so the count is not compared to before: the one count is the rail's.
  const after = await needsYouCount(page).innerText();
  await expect(railButton(page, /^Pip home/)).toHaveAccessibleName(`Pip home, ${after} ${after === "1" ? "thing needs" : "things need"} you`);
});

test("the sheet of a run stopped at its limit has Resume too, and resuming from it does the same", async ({ page }) => {
  await openApp(page, "runs=stuck");
  const id = (await mockRuns(page)).find((r) => r.state === "stopped" && r.key === "CA-277")!.id;
  await railButton(page, /^Agents/).click();
  await page.locator(`article[data-run-id="${id}"]`).click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Resume", exact: true }).click();
  await expectToast(page, "Resumed. Claude is picking it back up.");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
});
