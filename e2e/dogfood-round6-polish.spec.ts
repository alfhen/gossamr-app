import { expect, test } from "@playwright/test";
import { agentsHome, openAgents, openApp, startWorkstream, workstreamGroup } from "./support/app";

// The polish backlog of the sixth dogfood round: an idle workstream says Idle and asks nothing of the person.

test.describe("the workstream list (G17, G21)", () => {
  test("an idle workstream is Idle with no detail, and asks nothing of the person", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    const row = workstreamGroup(page, "CA-408");
    await expect(row.locator("[data-status]")).toHaveText("Idle");
    await expect(row.locator("[data-status-detail]")).toHaveCount(0);
    await expect(agentsHome(page).locator("[data-needs-you-count]")).toHaveText("0");
  });
});
