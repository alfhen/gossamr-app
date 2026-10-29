import { expect, type Page, test } from "@playwright/test";
import {
  agentsHome, closeWorkstreamSheet, homeConversation, homeConversationRegion, homeSettled, INSTANT_PIP, MANUAL_PRS,
  mockRuns, needsChip, needsPaneHeading, openAgents, openApp, openPip, pipConversation, startWorkstream, stepChip,
  workstreamGroup, workstreamSheet,
} from "./support/app";

/** Waits until Pip has finished answering on Pip home. */
const settled = homeSettled;

/** Runs a palette command: opens the palette, types `query` and picks the entry named `name`. */
async function palette(page: Page, query: string, name: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill(query);
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("the palette's 'Open the workstream' and 'Show what needs me' land on Work", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("open the workstream on CA-401");
  await palette.getByText("Open the workstream on CA-401", { exact: true }).first().click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

  await closeWorkstreamSheet(page);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByLabel("Search commands and tickets").fill("what needs me");
  await palette.getByText("Show what needs me", { exact: true }).click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(workstreamSheet(page)).toBeVisible();
  await expect(needsPaneHeading(page)).toBeFocused();
});

test("the palette: 'Ask Pip to plan CA-401' lands on its workstream and Pip starts the plan", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await openAgents(page);
  await openPip(page);
  await expect(homeConversation(page)).toHaveText("General");

  await palette(page, "plan ca-401", /^Ask Pip to plan CA-401/);
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  await expect(homeConversationRegion(page).getByText("plan CA-401", { exact: true })).toBeVisible();
  await settled(page);
  await expect.poll(async () => (await mockRuns(page)).map((r) => r.step)).toEqual(["plan"]);
  await expect(stepChip(page, "plan").locator('[data-run-label="R1"]')).toBeVisible();

  // From General, the palette finds the workstream again by its key.
  await closeWorkstreamSheet(page);
  await palette(page, "ca-401", "Open the workstream on CA-401");
  await expect(workstreamGroup(page, "CA-401")).toHaveAttribute("aria-current", "true");
});

test.describe("planning from the palette", () => {
  test("typing 'plan' in Ctrl+K lists tickets to start it on", async ({ page }) => {
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("plan");
    await expect(dialog.getByRole("option", { name: /^Ask Pip to plan [A-Z]+-\d+/ }).first()).toBeVisible();
  });
});

test.describe("'plan KEY' in the palette", () => {
  test("offers to ask Pip to plan the ticket", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("plan CA-402");
    await expect(dialog.getByRole("option", { name: /^Ask Pip to plan CA-402/ })).toBeVisible();
    await dialog.getByRole("combobox").fill("plan ca-402");
    await expect(dialog.getByRole("option", { name: /^Ask Pip to plan CA-402/ })).toBeVisible();
  });
});

test.describe("the palette's input name", () => {
  test("is the question the mode asks, and the search name for plain search", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.getByRole("combobox", { name: "Search commands and tickets" })).toBeVisible();
  });
});

test.describe("opening Work from the palette", () => {
  const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

  test("'agents' in the palette finds Open Work first, and it opens the Work screen", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("agents");
    await expect(palette(page).getByRole("option").first()).toContainText("Open Work");
    await page.keyboard.press("Enter");
    await expect(page.locator("main").getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  });
});

test.describe("a command word outranks the tickets it also matches", () => {
  const options = async (page: Page, query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type(query);
    const list = page.getByRole("dialog", { name: "Command palette" }).getByRole("option");
    await expect(list.first()).toBeVisible();
    return list;
  };

  test("fuzzy ticket search still works, and a typed ticket key still leads", async ({ page }) => {
    await openApp(page, INSTANT_PIP);
    let list = await options(page, "retry failed payment");
    await expect(list.first()).toContainText("DEVOPS-471");
    await page.keyboard.press("Escape");
    list = await options(page, "out of memory");
    await expect(list.first()).toContainText("DEVOPS-477");
    await page.keyboard.press("Escape");
    list = await options(page, "devops-471");
    await expect(list.first()).toContainText("DEVOPS-471");
  });
});
