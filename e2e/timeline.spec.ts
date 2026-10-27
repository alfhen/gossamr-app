import { expect, test, type Page } from "@playwright/test";
import { askPip, finishOnHome, homeConversation, homeConversationRegion, homeSettled, mockRuns, openAgents, openApp, selectWorkstream, startWorkstream } from "./support/app";

// Pull requests show only when a test says.
const SAMPLE = "runs=empty&prSurface=manual";

const timeline = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;


/**
 * A workstream on CA-401 opened on Pip home, its investigation asked of Pip: the chain's
 * first run. Returns the investigation.
 */
async function investigating(page: Page) {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await askPip(page, "investigate this");
  await homeSettled(page);
  await expect.poll(() => newest(page, "investigate")).not.toBeNull();
  return (await newest(page, "investigate"))!;
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
