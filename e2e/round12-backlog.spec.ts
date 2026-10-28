import { expect, test, type Page } from "@playwright/test";
import { agentsHome, openAgents, openApp, pipPane, selectWorkstream, startWorkstream } from "./support/app";

// Backlog items of the twelfth dogfood round: one story of who posts (G23), the workstream controls explaining themselves (G24), the Ctrl+0 note not queuing (G30), live regions said once (G31),
// names for a screen reader (G32), where F6 and Enter land (G33).

const VAGUE = "CA-408";
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("the workstream controls (G24, G31, G32)", () => {
  test("hint at Pause, Close and the menu, and say the notes are empty", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Pause" })).toHaveAccessibleDescription("Pip isn't woken; its agents carry on");
    await expect(controls.getByRole("button", { name: "Close…" })).toHaveAccessibleDescription("Its conversation goes back to General; its agents and drafts are kept in General");
    await expect(controls.getByRole("button", { name: "More for this workstream" })).toHaveAccessibleDescription("More: stop the workstream");
    await expect(agentsHome(page).getByRole("region", { name: "Pip's notes" })).toContainText("No notes yet.");
  });
});
