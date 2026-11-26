import { expect, type Page, test } from "@playwright/test";
import { agentsHome, mockRuns, openAgents, openApp, openRunOf, runSheet } from "./support/app";

/** Said when a message goes to a run handed over to Terminal; `HANDED_OVER_ASK` in src/types.ts. */
const HANDED_OVER_ASK = "It was handed over to Terminal. Say whether you took it back there before Gossamr resumes it.";
/** Said once Resume here took the run back; `RESUMED_HERE` in src/types.ts. */
const RESUMED_HERE = "Resumed here. Message the agent to go on.";

const runOf = async (page: Page, key: string) => (await mockRuns(page)).find((r) => r.key === key)!;
const card = (page: Page, key: string) => agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();

const message = (page: Page, id: string, text: string) =>
  page.evaluate(([id, text]) => (globalThis as unknown as { __gossamrMock: { messageAgent(id: string, text: string): string } }).__gossamrMock.messageAgent(id, text), [id, text] as const);

test("Take over hands a finished run to Terminal, shows its resume command, refuses a message, and Resume here asks before it reopens it", async ({ page }) => {
  await openApp(page, "runs=harness");
  await openAgents(page);
  await openRunOf(page, "DEVOPS-490");
  const sheet = runSheet(page);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Open in Terminal" }).first().click();
  const box = sheet.getByRole("group", { name: "Handed over to Terminal" });
  await expect(box).toContainText("Gossamr sends it no message until you resume it here.");
  await expect(box.locator("code")).toContainText("--resume");
  await expect(box.getByRole("button", { name: /Copy/ })).toBeVisible();
  await expect(card(page, "DEVOPS-490")).toContainText("Handed over to Terminal");
  const { id } = await runOf(page, "DEVOPS-490");
  expect(await message(page, id, "Go on.")).toBe(HANDED_OVER_ASK);

  await box.getByRole("button", { name: "Resume here" }).click();
  const ask = sheet.getByRole("group", { name: "Resume here" });
  await expect(ask).toContainText("Did you quit it in Terminal?");
  await ask.getByRole("button", { name: "Not yet" }).click();
  await expect(ask).toHaveCount(0);
  await expect(box).toBeVisible();
  await box.getByRole("button", { name: "Resume here" }).click();
  await ask.getByRole("button", { name: "Yes, resume here" }).click();
  await expect(box).toHaveCount(0);
  await expect(page.locator("[data-toast]").filter({ hasText: RESUMED_HERE })).toHaveCount(1);
  expect(await message(page, id, "Go on.")).not.toBe(HANDED_OVER_ASK);
});

test("a request Gossamr can only deny offers Take over in Terminal, which hands the run over", async ({ page }) => {
  await openApp(page, "runs=permissions");
  await openAgents(page);
  const request = card(page, "WEB-102").locator("[data-permission-request]").first();
  await request.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await request.getByRole("button", { name: "Take over in Terminal" }).click();
  // Off the request, so its place is no longer held for the pointer.
  await page.mouse.move(0, 0);
  await expect(card(page, "WEB-102")).toContainText("Handed over to Terminal");
  expect((await runOf(page, "WEB-102")).state).toBe("stopped");
});
