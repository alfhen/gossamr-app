import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, expectToast, showWorkspace, mockRuns, startAgent } from "./support/app";

/** A run's card or row in the Agents view; Pip's strip of agents shows runs too, and only the view counts. */
const agentRun = (page: Page, id: string) => page.locator(`main [data-run-id="${id}"]:not(aside[aria-label="Pip"] *)`).first();
const LIVE = ["launching", "working", "needsAnswer", "needsPermission", "systemBlocked"];

/** How many of the sample backend's runs take a slot. */
const live = async (page: Page) => (await mockRuns(page)).filter((r) => LIVE.includes(r.state)).length;

/** Starts an investigation on `key` as Pip does and returns its run's id, with the Agents view showing. */
async function start(page: Page, key: string): Promise<string> {
  const id = await startAgent(page, key, "investigate");
  await page.getByRole("button", { name: /^Agents/ }).click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  if (await sheet.isVisible()) await page.keyboard.press("Escape");
  return id;
}

test("with three agents running a 4th approved run waits for a slot, never over the cap, and launches when one finishes", async ({ page }) => {
  // A signed-in GitHub connection, so there are repositories to run in (`?mockRepos`, src/backend/mockWatch.ts).
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    running.push(await start(page, key));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  expect((await mockRuns(page)).filter((r) => running.includes(r.id)).map((r) => r.state)).toEqual(["working", "working", "working"]);

  // The 4th waits for a slot.
  const fourth = await start(page, "CA-404");
  await expect(agentRun(page, fourth)).toContainText("Waiting for a slot · 1st in line");
  expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("queued");

  // Stepping it along leaves it waiting, and the cap holds.
  for (let i = 0; i < 2; i++) {
    await advanceRuns(page, 1, fourth);
    expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("queued");
    expect(await live(page)).toBe(3);
  }
  await expect(agentRun(page, fourth)).toContainText("Waiting for a slot · 1st in line");

  // One finishes, and the waiting one launches by itself.
  await advanceRuns(page, 1, running[0]);
  expect((await mockRuns(page)).find((r) => r.id === running[0])?.state).toBe("done");
  expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("launching");
  expect(await live(page)).toBe(3);
  await expect(agentRun(page, fourth)).not.toContainText("Waiting for a slot");
  await expect(agentRun(page, fourth)).toHaveAttribute("data-state", "launching");
  await advanceRuns(page, 1, fourth);
  await expect(agentRun(page, fourth)).toHaveAttribute("data-state", "working");
  expect(await live(page)).toBe(3);
});

test("a run waiting for a slot can be stopped from its sheet, and Stop all stops the waiting ones too and launches nothing", async ({ page }) => {
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    running.push(await start(page, key));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  const waiting: string[] = [];
  for (const key of ["CA-404", "CA-405"]) {
    waiting.push(await start(page, key));
  }
  // Counted apart from the running ones.
  await expect(page.locator("main")).toContainText("3 running · 2 waiting for a slot");

  // From its sheet the second in line says it starts on its own, offers no Start now, and can be stopped.
  await agentRun(page, waiting[1]).click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet).toContainText("It is approved and starts on its own when one of the running agents finishes (2nd in line). Stop it if you no longer want it.");
  await expect(sheet.getByRole("button", { name: "Start now" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Stop", exact: true }).click();
  await sheet.getByRole("button", { name: "Yes, stop" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === waiting[1])?.state).toBe("stopped");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Stop all names the one still waiting, stops it with the rest, and nothing takes the freed slots.
  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Stop all agents" });
  await expect(confirm).toContainText("Stop 3 agents and 1 waiting to start?");
  await confirm.getByRole("button", { name: "Yes, stop all" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === waiting[0])?.state).toBe("stopped");
  expect((await mockRuns(page)).filter((r) => [...running, ...waiting].includes(r.id)).map((r) => r.state)).toEqual(["stopped", "stopped", "stopped", "stopped", "stopped"]);
  await advanceRuns(page, 2);
  expect(await live(page)).toBe(0);
  // Toasts show one at a time and each stays for seconds, so this one queues behind the earlier ones; expectToast clears those.
  await expectToast(page, "Stopped 3 agents and 1 waiting to start");
});
