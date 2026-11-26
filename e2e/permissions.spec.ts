import { expect, type Page, test } from "@playwright/test";
import { agentsHome, expandNeedsYou, mockPermissionAnswers, openNeedRow, mockRuns, mockWithdrawPermission, needRow, needsPane, needsPaneHeading, openAgents, openApp, openRunOf, runSheet } from "./support/app";

/** The mock's long command on CA-407, `LONG_COMMAND` in src/backend/mockRuns.ts. */
const LONG_COMMAND = 'pnpm vitest run src/campaigns/sendTime.test.ts src/campaigns/schedule.test.ts --reporter=verbose && git add src/campaigns/sendTime.ts src/campaigns/sendTime.test.ts && git commit -m "Pick each campaign\'s send time from the last 30 days of opens"';

const card = (page: Page, key: string) => agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();
const requestsOn = (page: Page, key: string) => card(page, key).locator("[data-permission-request]");
const runId = async (page: Page, key: string) => (await mockRuns(page)).filter((r) => r.key === key).slice(-1)[0].id;

test.beforeEach(async ({ page }) => {
  await openApp(page, "runs=permissions");
  await openAgents(page);
});

test("a command the agent asks to run shows whole on its card with Allow and Deny, and Allow lets it go on", async ({ page }) => {
  const ask = requestsOn(page, "CA-407");
  await expect(ask).toHaveCount(1);
  await expect(ask).toContainText("wants to run a command");
  await expect(ask.locator("code").last()).toHaveText(LONG_COMMAND);
  await expect(ask.getByRole("button", { name: "Deny" })).toBeVisible();
  await ask.getByRole("button", { name: "Allow" }).click();
  await expect(requestsOn(page, "CA-407")).toHaveCount(0);
  await expect(card(page, "CA-407")).toContainText("Allowed Bash");
  expect(await mockPermissionAnswers(page)).toEqual([{ run: await runId(page, "CA-407"), request: "perm-1", decision: "allow" }]);
});

test("two open requests are two items, each answered on its own, and the run waits until the last", async ({ page }) => {
  await expect(requestsOn(page, "WEB-100")).toHaveCount(2);
  await requestsOn(page, "WEB-100").first().getByRole("button", { name: "Deny" }).click();
  await expect(requestsOn(page, "WEB-100")).toHaveCount(1);
  await expect(requestsOn(page, "WEB-100")).toContainText("git push origin web-100-page-speed-2a3b");
  expect((await mockPermissionAnswers(page)).map((a) => [a.request, a.decision])).toEqual([["perm-2", "deny"]]);
  await requestsOn(page, "WEB-100").getByRole("button", { name: "Allow" }).click();
  await expect(requestsOn(page, "WEB-100")).toHaveCount(0);
});

test("a request the harness cut offers only Deny and says why", async ({ page }) => {
  const ask = requestsOn(page, "SUP-13");
  await expect(ask).toContainText("It was too long for Gossamr to get whole, so you can only deny it.");
  await expect(ask.getByRole("button", { name: "Allow" })).toHaveCount(0);
  await ask.getByRole("button", { name: "Deny" }).click();
  await expect(requestsOn(page, "SUP-13")).toHaveCount(0);
});

test("a request for more permissions carries a plain warning", async ({ page }) => {
  await expect(requestsOn(page, "DEVOPS-472")).toContainText("wants to change its own permissions");
  await expect(requestsOn(page, "DEVOPS-472")).toContainText("Allowing this gives the agent more access than it started with.");
});

test("a request the agent withdrew leaves its card", async ({ page }) => {
  await expect(requestsOn(page, "WEB-100")).toHaveCount(2);
  await mockWithdrawPermission(page, await runId(page, "WEB-100"), "perm-2");
  await expect(requestsOn(page, "WEB-100")).toHaveCount(1);
  expect(await mockPermissionAnswers(page)).toEqual([]);
});

test("Needs you lists one item per request; opened from the badge, it lands on the heading and the keys allow nothing", async ({ page }) => {
  await expandNeedsYou(page, "General");
  await expect(needRow(page, /WEB-100/)).toHaveCount(2);
  await openNeedRow(page, /CA-407/);
  await expect(needsPaneHeading(page)).toBeFocused();
  await expect(needsPane(page).locator("code").last()).toHaveText(LONG_COMMAND);
  const allow = needsPane(page).getByRole("button", { name: "Allow" });
  await expect(allow).toBeVisible();
  await expect(allow).not.toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  expect(await mockPermissionAnswers(page)).toEqual([]);
  await allow.click();
  await expect(needRow(page, /CA-407/)).toHaveCount(0);
  expect((await mockPermissionAnswers(page)).map((a) => a.decision)).toEqual(["allow"]);
});

test("the run sheet shows each request whole with its two buttons, and focuses neither", async ({ page }) => {
  await openRunOf(page, "WEB-100");
  const sheet = runSheet(page);
  await expect(sheet).toContainText("The agent is asking 2 permissions");
  await expect(sheet.locator("[data-permission-request]")).toHaveCount(2);
  await expect(sheet.locator("[data-permission-request]").first()).toContainText("src/components/ProductPage.tsx");
  for (const name of ["Allow", "Deny"]) await expect(sheet.getByRole("button", { name }).first()).not.toBeFocused();
});
