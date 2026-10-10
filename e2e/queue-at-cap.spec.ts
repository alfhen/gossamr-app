import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, landOnWorkspace, mockRuns, peekSheet, peekTicket } from "./support/app";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
/** A run's card or row in the Agents view; Pip's strip of agents shows runs too, and only the view counts. */
const agentRun = (page: Page, id: string) => page.locator(`main [data-run-id="${id}"]:not(aside[aria-label="Pip"] *)`).first();
const LIVE = ["launching", "working", "needsAnswer", "needsPermission", "systemBlocked"];

/** How many of the sample backend's runs take a slot. */
const live = async (page: Page) => (await mockRuns(page)).filter((r) => LIVE.includes(r.state)).length;

/** Opens the setup sheet for an investigation of `key` from its peek's Agent menu, past the one-time safety sheet. */
async function openSetup(page: Page, key: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const board = page.getByRole("button", { name: "All projects", exact: true });
    if (await board.isVisible()) await board.click();
    await peekTicket(page, key);
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
  }
  await expect(setup(page)).toContainText(key);
  await setup(page).getByRole("combobox", { name: "Repository" }).selectOption("acme/webshop");
  await expect(setup(page).getByRole("group", { name: "Checks before you approve" })).toContainText("What runs");
}

/** Starts the agent the setup sheet shows, and returns its run's id; the newest run is first in the sample backend. */
async function start(page: Page): Promise<string> {
  const before = (await mockRuns(page)).length;
  const button = setup(page).getByRole("button", { name: "Start agent" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(setup(page)).toHaveCount(0);
  await expect.poll(async () => (await mockRuns(page)).length).toBe(before + 1);
  const id = (await mockRuns(page))[0].id;
  // Starting opens the run's sheet over the Agents view.
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  if (await sheet.isVisible()) await page.keyboard.press("Escape");
  return id;
}

test("with three agents running a 4th approved run waits for a slot, never over the cap, and launches when one finishes", async ({ page }) => {
  // A signed-in GitHub connection, so the setup sheet has repositories to run in (`?mockRepos`, src/backend/mockWatch.ts).
  await landOnWorkspace(page);
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    await openSetup(page, key);
    await expect(setup(page).locator('[data-level="green"]', { hasText: /agents running$/ })).toBeVisible();
    running.push(await start(page));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  expect((await mockRuns(page)).filter((r) => running.includes(r.id)).map((r) => r.state)).toEqual(["working", "working", "working"]);

  // The 4th: the checks say it will wait, and Start stays on.
  await openSetup(page, "CA-404");
  const wait = setup(page).locator('[data-level="amber"]', { hasText: "3 of 3 agents are running. This one will wait for a slot and start when one finishes." });
  await expect(wait).toBeVisible();
  await expect(setup(page).locator('[data-level="red"]')).toHaveCount(0);
  const fourth = await start(page);
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
  await landOnWorkspace(page);
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    await openSetup(page, key);
    running.push(await start(page));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  const waiting: string[] = [];
  for (const key of ["CA-404", "CA-405"]) {
    await openSetup(page, key);
    waiting.push(await start(page));
  }
  // Announced as waiting, not as started, and counted apart from the running ones.
  await expect(page.getByText("Approved the agent on CA-405. Every slot is taken, so it waits and starts when one of the running agents finishes.")).toBeVisible();
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
  await expect(page.getByText("Stopped 3 agents and 1 waiting to start")).toBeVisible();
});
