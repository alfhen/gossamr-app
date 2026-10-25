import { expect, test, type Locator } from "@playwright/test";
import { agentsHome, commentOnTicket, expectToast, jiraWrites, needsPane, openAgents, openApp, pipPane, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// The polish backlog of the sixth dogfood round: a workstream closed on a ticket that is not Done is "closed, not done" and can
// be reopened, the workstream list keeps the open workstream under a status filter, an idle pill says "may be unclear", the
// reporter's reply leaves a trace, and what Looks fine taught is said and can be given back by gap.

const port = Number(process.env.E2E_PORT ?? 4173);
/** A profile that said Looks fine to every gap in CA often enough to stop being told. */
const LEARNED = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ clarityLearning: { CA: { short: 3, done: 3, scope: 3, who: 3 } } }) }] }] };

const notice = (scope: Locator) => scope.locator("[data-clarity-notice]");

test.describe("the workstream list (G17, G21)", () => {
  test("an idle workstream whose ticket may be unclear says so in the pill's detail, and stays Idle (a notice is no need)", async ({ page }) => {
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    const row = workstreamGroup(page, "CA-408");
    await expect(row.locator("[data-status]")).toHaveText("Idle");
    await expect(row.locator("[data-status-detail]")).toHaveText("· may be unclear");
    await expect(agentsHome(page).locator("[data-needs-you-count]")).toHaveText("0");
  });

});

test.describe("the reporter's reply (G16)", () => {
  test("leaves a line in the timeline and the notice says the reporter replied", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await notice(agentsHome(page)).getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", "CA-408"]]);
    await expect(agentsHome(page).locator("[data-next-step]")).toContainText("Waiting on the reporter since");
    await expect(pipPane(page).locator("[data-timeline]")).not.toContainText("The reporter replied on the ticket");

    await commentOnTicket(page, "CA-408", "It should send three emails.");
    await expect(pipPane(page).locator("[data-timeline]")).toContainText("The reporter replied on the ticket");
    // The notice is back, but it doesn't repeat the gaps as if nothing was said.
    await expect(notice(agentsHome(page))).toContainText("CA-408: the reporter replied; read it, then Looks fine or ask again.");
    await expect(notice(agentsHome(page))).not.toContainText("may be unclear");
    expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  });
});

test.describe("what Looks fine taught (G19)", () => {
  test.use({ storageState: LEARNED });

  test("a workstream says quietly what it does not flag, and a single gap is given back from Settings", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    // Everything is taught away: no notice, but the note says so.
    await expect(notice(agentsHome(page))).toHaveCount(0);
    const quiet = agentsHome(page).locator("[data-clarity-quiet]");
    await expect(quiet).toContainText("Not flagged: you said Looks fine to");
    await expect(quiet).toContainText("in CA tickets");

    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    const learned = page.locator("[data-clarity-learning]");
    await expect(learned).toContainText("Say Looks fine to the same gap 3 times");
    await expect(learned.locator('[data-clarity-project="CA"] [data-clarity-gap]')).toHaveCount(4);
    await learned.getByRole("button", { name: "Give back short description in CA" }).click();
    await expectToast(page, "Gossamr will flag CA tickets with short description as before.");
    await expect(learned.locator('[data-clarity-project="CA"] [data-clarity-gap]')).toHaveCount(3);
    await expect(learned.locator('[data-clarity-gap="short"]')).toHaveCount(0);

    // That gap alone is flagged again on the workstream.
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await expect(notice(agentsHome(page))).toContainText("CA-408 may be unclear: it has a very short description.");
    await expect(agentsHome(page).locator("[data-clarity-quiet]")).toContainText("Not flagged: you said Looks fine to");
  });
});
