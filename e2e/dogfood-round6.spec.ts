import { expect, test, type Page } from "@playwright/test";
import { openAgents, openApp, pipPane, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// Fixes from the sixth dogfood round: Start my day and Plan my week leave the timeline its room and Start my day is General's
// alone, the status words are explained, and the Plan my week add box says why a ticket was not added.


const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("status words explained (G6)", () => {
  test("a row's pill and the header's pill carry what the word means", async ({ page }) => {
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    const pill = workstreamGroup(page, "CA-402").locator("[data-status]");
    await expect(pill).toHaveText("Idle");
    await expect(pill).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    // The same words are in the row as text for a screen reader, which the pill is described by.
    await expect(workstreamGroup(page, "CA-402").locator("[data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
    await expect(pill).toHaveAttribute("aria-describedby", /.+/);
    await selectWorkstream(page, "CA-402");
    await expect(pipPane(page).locator("[data-header-status]")).toHaveAttribute("title", /Nothing is running and nothing waits on you/);
    await expect(pipPane(page).locator("[data-header-status] [data-status-hint]")).toHaveText(/Nothing is running and nothing waits on you/);
  });
});

