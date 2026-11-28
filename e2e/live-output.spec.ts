import { expect, type Page, test } from "@playwright/test";
import { advanceRuns, openAgents, openApp, runSheet, startAgent } from "./support/app";

type Streams = { __gossamrMock?: { streamText(id: string, piece: string): void; sayText(id: string, text: string): void } };
const NO_MOCK = "the sample backend isn't there; is this a dev build in mock mode?";

/** Has working run `id` stream `piece` of its block, as the harness sends one (`MockRuns.stream`). */
const stream = (page: Page, id: string, piece: string) =>
  page.evaluate(
    ({ id, piece, missing }) => {
      const mock = (globalThis as Streams).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.streamText(id, piece);
    },
    { id, piece, missing: NO_MOCK },
  );

/** Ends run `id`'s block with its whole `text`, as a driver does after the pieces (`MockRuns.say`). */
const say = (page: Page, id: string, text: string) =>
  page.evaluate(
    ({ id, text, missing }) => {
      const mock = (globalThis as Streams).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.sayText(id, text);
    },
    { id, text, missing: NO_MOCK },
  );

const timeline = (page: Page) => runSheet(page).getByRole("list", { name: "What the agent did" });
const streamed = (page: Page) => timeline(page).locator("li[data-streamed]");
/** Each row of the timeline as its text reads, the streamed block last, without the line that says the run is working. */
const rows = (page: Page) => timeline(page).locator(":scope > li:not([data-progress])").allInnerTexts();

async function working(page: Page) {
  await openApp(page);
  await openAgents(page);
  const id = await startAgent(page, "CA-401", "investigate");
  const card = page.locator(`main article[data-run-id="${id}"]`);
  await expect(async () => {
    if ((await card.getAttribute("data-state")) !== "working") await advanceRuns(page, 1, id);
    await expect(card).toHaveAttribute("data-state", "working", { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  return { id, card };
}

test("a sheet opened in the middle of a turn shows the whole turn once, in order, and the card shows the line being written", async ({ page }) => {
  const { id, card } = await working(page);
  await stream(page, id, "Reading the ");
  await stream(page, id, "cart module.");
  await say(page, id, "Reading the cart module.");
  await stream(page, id, "Now the rounding ");
  await stream(page, id, "code");
  await expect(card).toContainText("Now the rounding code");

  await card.click();
  await expect(streamed(page)).toHaveText("Now the rounding code");
  await expect(timeline(page).getByText("Reading the cart module.", { exact: true })).toHaveCount(1);
  const before = await rows(page);
  expect(before.findIndex((row) => row.includes("Reading the cart module."))).toBeLessThan(before.length - 1);
  expect(before[before.length - 1]).toBe("Now the rounding code");

  await stream(page, id, ", then the totals.");
  await expect(streamed(page)).toHaveText("Now the rounding code, then the totals.");
  await say(page, id, "Now the rounding code, then the totals.");
  await expect(streamed(page)).toHaveCount(0);
  await expect(timeline(page).getByText("Now the rounding code, then the totals.", { exact: true })).toHaveCount(1);
  const after = await rows(page);
  const first = after.findIndex((row) => row.includes("Reading the cart module."));
  const second = after.findIndex((row) => row.includes("Now the rounding code, then the totals."));
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  expect(after.filter((row) => row.includes("Reading the cart module.")).length).toBe(1);
  expect(after.filter((row) => row.includes("Now the rounding code")).length).toBe(1);
});

test("the sheet replaces a block's streamed pieces with its stored text, and a turn that ends drops what streamed", async ({ page }) => {
  const { id, card } = await working(page);
  await card.click();
  await expect(timeline(page)).toBeVisible();
  await stream(page, id, "Checking the ");
  await expect(streamed(page)).toHaveText("Checking the");
  await stream(page, id, "logs");
  await expect(streamed(page)).toHaveText("Checking the logs");
  // The stored text is what the harness masked, which the pieces only approached.
  await say(page, id, "Checked the logs: 38 matches.");
  await expect(streamed(page)).toHaveCount(0);
  await expect(timeline(page).getByText("Checked the logs: 38 matches.", { exact: true })).toHaveCount(1);
  await expect(timeline(page).getByText("Checking the logs")).toHaveCount(0);

  await stream(page, id, "Writing it up");
  await expect(streamed(page)).toHaveText("Writing it up");
  await advanceRuns(page, 1, id);
  await expect(card).toHaveAttribute("data-state", "done");
  await expect(streamed(page)).toHaveCount(0);
  await expect(timeline(page).getByText("Writing it up")).toHaveCount(0);
  await expect(card).not.toContainText("Writing it up");
});
