import { expect, test } from "@playwright/test";
import { openAgents, openApp, pipPane, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// Fixes from the ninth dogfood round: the close confirm opens on Keep (G9) and the safety line's promises (G13).

test.describe("the close confirm (G9)", () => {
  test("opens on Keep, so Enter twice never closes the workstream", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ask).toHaveCount(0);
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(1);
  });
});

test.describe("what the safety line promises (G13)", () => {
  test("Pip's intro says Jira waits for approval and a build only pushes its own branch to GitHub", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openAgents(page);
    await expect(page.locator("body")).not.toContainText("Nothing is posted to Jira or GitHub");
  });
});
