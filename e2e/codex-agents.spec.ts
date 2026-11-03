import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, mockAttached, mockRuns, openApp, railButton, runSheet, startAgent } from "./support/app";

const QUERY = "runs=empty&mockRepos=6";

const agentsPicker = (page: Page) => page.getByRole("button", { name: /^New agents use / });
const pipPicker = (page: Page) => page.getByRole("button", { name: /^Pip uses / });
const attachCommands = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gossamrMock: { attachCommands(): string[] } }).__gossamrMock.attachCommands());

async function addCodex(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByRole("menuitem", { name: /^Codex/ }).click();
  const sheet = page.getByRole("dialog", { name: "Add Codex" });
  await sheet.getByLabel("Name").fill("Codex side");
  await sheet.getByRole("button", { name: "Add Codex" }).click();
  await sheet.getByRole("button", { name: "Open Terminal" }).click();
  await sheet.getByRole("button", { name: "I've run it, check again" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
}

test("an agent runs on the Codex chosen for New agents use, opens in Terminal with codex resume and reports its answer", async ({ page }) => {
  await openApp(page, QUERY);
  await addCodex(page);

  await agentsPicker(page).click();
  await page.getByRole("menu", { name: "New agents use" }).getByRole("group", { name: "Codex side" }).getByRole("menuitemradio").first().click();
  await expect(agentsPicker(page)).toHaveAccessibleName(/^New agents use Codex side · /);
  await expect(page.locator("[data-promises]")).toContainText("Agents run on Codex side with its own Codex settings. Only danger-full-access lets them commit and push.");

  const id = await startAgent(page, "CA-401", "investigate");
  expect((await mockRuns(page)).find((r) => r.id === id)?.runsOn?.instanceId).toBe("codex");

  await railButton(page, /^Work/).click();
  const card = page.locator(`main article[data-run-id="${id}"]`);
  await expect(card.getByRole("button", { name: /^Runs on Codex side · / })).toBeVisible();

  await advanceRuns(page, 3, id);
  await card.getByRole("button", { name: "Open in Terminal" }).click();
  expect(await mockAttached(page)).toEqual([id]);
  expect(await attachCommands(page)).toEqual(["codex resume"]);

  await advanceRuns(page, 12, id);
  await expect(card).toHaveAttribute("data-state", "done");
  await card.click();
  await expect(runSheet(page).locator("[data-run-report]")).toBeVisible();
});

test("Pip's picker still greys Codex with the reason", async ({ page }) => {
  await openApp(page, QUERY);
  await addCodex(page);
  await pipPicker(page).click();
  const pip = page.getByRole("menu", { name: "Pip uses" }).getByRole("group", { name: "Codex side" });
  await expect(pip).toContainText("Pip runs on Claude only.");
  await expect(pip).toContainText("Beta");
  await expect(pip.getByRole("menuitemradio")).toHaveCount(0);
});
