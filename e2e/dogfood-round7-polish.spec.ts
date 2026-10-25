import { test, type Locator } from "@playwright/test";
import { agentsHome, expectToast, openAgents, openApp, selectWorkstream, startWorkstream } from "./support/app";

// The polish backlog of the seventh dogfood round: the reporter's reply is quoted and opens its comment, a reopened plan
// item says its workstream is closed, Looks fine names the gaps it counts, the Decide pane's Done line names its workstream
// and goes back to it, Keep this plan stays in reach, closed titles wrap, the quiet note says where Flag again
// applies, a wait says when it began, the clarity notice is an F6 stop, and a second ask of the reporter is a line of
// its own.


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
