import { expect, test, type Page } from "@playwright/test";
import { openAgents, openApp } from "./support/app";

async function agentSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
  await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: "Agent settings" });
}

test.describe("Claude agents' permissions", () => {
  test("are Auto by default, and Ask for each step once you choose it, after the sheet opens again", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    const sheet = await agentSettings(page);
    const permissions = sheet.getByRole("combobox", { name: "Claude agents' permissions" });
    await expect(permissions).toHaveValue("auto");
    await expect(sheet).toContainText("Claude decides which steps are safe and runs them. It can push, delete or reset without asking you.");
    await permissions.selectOption({ label: "Ask for each step" });
    await expect(permissions).toHaveValue("ask");
    await expect(sheet).toContainText("You allow or deny each step that needs it.");
    // Saved, not only drawn: the sheet opened again reads the stored value.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    const again = await agentSettings(page);
    await expect(again.getByRole("combobox", { name: "Claude agents' permissions" })).toHaveValue("ask");
    await again.getByRole("combobox", { name: "Claude agents' permissions" }).selectOption("auto");
    await expect(again.getByRole("combobox", { name: "Claude agents' permissions" })).toHaveValue("auto");
  });
});
