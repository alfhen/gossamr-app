import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, expectToast, groupByState, mockRuns, needsYouCount, openAgents, openApp, expandNeedsYou, needsStack } from "./support/app";

// A run Gossamr stopped at its limit: it needs the person, counted in Needs you, and only the person's Resume carries it on.

const railButton = (page: Page, name: RegExp) => page.locator("[data-rail]").getByRole("button", { name }).first();
const limitItems = (page: Page) => needsStack(page).locator('[data-needs-pane][data-kind="stoppedAtLimit"]');

test("a run stopped at its limit is in Needs you, with its pill in the Agents lane, and only Resume carries it on", async ({ page }) => {
  await openApp(page, "runs=stuck");
  const stopped = (await mockRuns(page)).find((r) => r.state === "stopped" && r.key === "CA-277");
  expect(stopped, "the stuck sample has a plan run stopped at its limit").toBeTruthy();
  const id = stopped!.id;

  // Pip home's Needs you counts it, as an item of its own.
  await openAgents(page);
  await expandNeedsYou(page, "General");
  await expect(limitItems(page)).toHaveCount(1);
  await expect(limitItems(page)).toContainText("stopped at its limit");
  const count = await needsYouCount(page).innerText();

  // The Agents view lists it under Failed or stuck with an "In Needs you" pill, and its header says the same one count.
  await railButton(page, /^Agents/).click();
  await groupByState(page);
  const lane = page.locator('[data-lane="bad"]');
  const card = lane.locator(`article[data-run-id="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Stopped at limit");
  await expect(card.locator("[data-in-needs-you]")).toBeVisible();
  await expect(railButton(page, /^Agents/)).toHaveAccessibleName(`Agents, ${count} ${Number(count) === 1 ? "thing needs" : "things need"} you`);
  await expect(needsYouCount(page)).toHaveText(count);

  // Nothing resumes it by itself: still stopped after the sample's runs have moved on.
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
  await openAgents(page);
  await expect(limitItems(page)).toHaveCount(0);
  // The sample's other runs moved meanwhile, so the count is not compared to before: the one count is the rail's.
  const after = await needsYouCount(page).innerText();
  await expect(railButton(page, /^Agents/)).toHaveAccessibleName(`Agents, ${after} ${after === "1" ? "thing needs" : "things need"} you`);
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
