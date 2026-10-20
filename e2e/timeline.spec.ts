import { expect, test, type Page } from "@playwright/test";
import { askPip, finishOnHome, homeConversation, homeConversationRegion, homeRunCards, homeSettled, inlineStart, mockRuns, openAgents, openApp, selectWorkstream, startWorkstream } from "./support/app";

// New workstreams open in Manage, so the sample supervisor starts the routine next steps; pull requests show only when a test says.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const timeline = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Waits for a rule to have started the next run of `kind`, and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}


/**
 * A managed workstream on CA-401 opened on Pip home, its investigation asked of Pip and started in place: the chain's
 * first run. Returns the investigation.
 */
async function investigating(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await askPip(page, "investigate this");
  await homeSettled(page);
  const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await review.getByRole("button", { name: "Start agent" }).click();
  await expect(review).toHaveCount(0);
  return (await started(page, "investigate"))!;
}


test("a new turn keeps the place of someone reading older entries, and follows someone at the end", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const r1 = await investigating(page);
  const body = timeline(page);
  const metrics = () => body.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  await expect.poll(async () => (await metrics()).max).toBeGreaterThan(40);
  // At the end, the wake that run's finish brings follows the person down.
  await expect.poll(async () => { const m = await metrics(); return m.max - m.top; }).toBeLessThanOrEqual(24);
  // Scrolled up to older entries, it doesn't.
  await body.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect.poll(async () => (await metrics()).top).toBe(0);
  await finishOnHome(page, r1.id);
  expect((await metrics()).top).toBe(0);
  // Asking Pip lands at the end, wherever they were reading.
  await askPip(page, "what next?");
  await homeSettled(page);
  await expect.poll(async () => { const m = await metrics(); return m.max - m.top; }).toBeLessThanOrEqual(24);
});
