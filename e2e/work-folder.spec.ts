import { expect, type Page, test } from "@playwright/test";
import { mockWorkFolderRevealed, openAgents, openApp, openRunOf, runSheet } from "./support/app";

async function openAgentSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Agent settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Where agents work", () => {
  test("says where agents work and who commits there, and reveals the folder without naming a path", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    const settings = await openAgentSettings(page);
    const section = settings.locator("section", { has: page.getByRole("heading", { name: "Where agents work" }) });
    await expect(section).toContainText("Agents work in Gossamr's own clones in ~/Gossamr/agents, one per repository");
    await expect(section).toContainText("Your clones in ~/Code and other folders aren't used or changed");
    await expect(section).toContainText("Commits in Gossamr's clones are by alf@acme.example.");
    await expect(section).not.toContainText("choose an address by folder");

    expect(await mockWorkFolderRevealed(page)).toBe(0);
    await section.getByRole("button", { name: "Reveal in Finder" }).click();
    await expect.poll(() => mockWorkFolderRevealed(page)).toBe(1);
  });

  test("warns when git settings choose an address by folder", async ({ page }) => {
    await openApp(page, "runs=empty&runsGitRules=1");
    await openAgents(page);
    const settings = await openAgentSettings(page);
    await expect(settings).toContainText("Your git settings choose an address by folder. Add a rule for ~/Gossamr/agents/<owner>/ to use it in Gossamr's clones too.");
  });
});

test("a run in Gossamr's clone says who its commits are by", async ({ page }) => {
  await openApp(page);
  await openAgents(page);
  await openRunOf(page, "WEB-108");
  await expect(runSheet(page)).toContainText("Commits as alf@acme.example");
});
