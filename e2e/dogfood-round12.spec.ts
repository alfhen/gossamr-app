import { expect, test } from "@playwright/test";
import { homeComposer, openAgents, openApp, pipPane, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// Fixes from the twelfth dogfood round: unsent text kept per workstream (G1).

test.describe("the composer per workstream (G1)", () => {
  test("keeps unsent text with its own workstream and never sends it from another", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await homeComposer(page).fill("half a thought about 408");
    await selectWorkstream(page, "CA-402");
    await expect(homeComposer(page)).toHaveValue("");
    await homeComposer(page).fill("something for 402");
    await selectWorkstream(page, "CA-408");
    await expect(homeComposer(page)).toHaveValue("half a thought about 408");
    await selectWorkstream(page, "CA-402");
    await expect(homeComposer(page)).toHaveValue("something for 402");
  });
});

test.describe("keyboard and screen reader (G5, G10, G14)", () => {
  test("closing a workstream takes it off the list and back to General, and the conversation's name is a heading", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(pipPane(page).getByRole("heading", { level: 2, name: /Workstream: CA-401/ })).toBeVisible();
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(0);
    await expect(pipPane(page).getByRole("heading", { level: 2, name: "General" })).toBeVisible();
  });
});
