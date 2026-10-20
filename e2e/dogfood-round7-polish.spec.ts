import { expect, test, type Locator } from "@playwright/test";
import { agentsHome, expectToast, openAgents, openApp, peekSheet, peekTicket, selectWorkstream, startWorkstream } from "./support/app";

// The polish backlog of the seventh dogfood round: the reporter's reply is quoted and opens its comment, a reopened plan
// item says its workstream is closed, Looks fine names the gaps it counts, the Decide pane's Done line names its workstream
// and goes back to it, the safety sheet's "Cancelled" note goes when the sheet comes back, Keep this plan stays in reach,
// closed titles wrap, the quiet note says where Flag again applies, a wait says when it began, the clarity notice is an F6
// stop, and a second ask of the reporter is a line of its own.


const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");




test.describe("Looks fine (G17, G23)", () => {
  test("the counter toast names the gaps it counts", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await notice(agentsHome(page)).getByRole("button", { name: "Looks fine" }).click();
    await expectToast(page, /^Noted for short description.*\. After 2 more Looks fine on CA tickets like this/);
  });

});

test.describe("the one-time safety sheet (G20)", () => {
  test("the 'Nothing was started' note is gone when the start comes back for the same thing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
    const setup = page.getByRole("dialog", { name: "Start an agent" });
    const investigate = async () => {
      await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    };
    await peekTicket(page, "CA-401");
    await investigate();
    await expect(safety).toBeVisible();
    await safety.getByRole("button", { name: "Close" }).click();
    await expectToast(page, "Cancelled: Investigate CA-401. Nothing was started.");
    await investigate();
    await expect(setup).toBeVisible();
    // Counted at once: the note would go by itself after a few seconds, so waiting for it to leave proves nothing.
    expect(await page.locator("[data-toast]").filter({ hasText: "Nothing was started" }).count()).toBe(0);
  });
});
