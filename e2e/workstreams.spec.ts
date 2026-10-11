import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream } from "./support/app";

/** Where the sample backend keeps workstreams (MOCK_WORKSTREAMS_KEY in src/backend/mockWorkstreams.ts). */
const STORE = "gossamr-mock-workstreams";

const GENERAL_QUESTION = "What am I looking at?";
const WORKSTREAM_QUESTION = "What does this ticket need next?";
// What the sample Pip says when nothing in the question asks for anything (scriptPip in src/backend/mockPip.ts).
const ANSWER = "Ask me to show stale or blocked tickets";

const kept = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as { workstreams?: { itemKey: string | null; title: string }[] }, STORE);

/** Asks Pip and waits until the turn is over. */
async function askAndWait(page: Page, question: string) {
  await askPip(page, question);
  await expect(pipPane(page).getByText(question, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(ANSWER).last()).toBeVisible();
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

test("Start a workstream in the peek opens its own conversation in Pip, at intake", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Intake$/);
  const peek = peekSheet(page);
  await expect(peek.getByRole("button", { name: "Start a workstream" })).toHaveCount(0);
  await expect(peek.getByText("Workstream · Intake")).toBeVisible();
  await expect(peek.locator("#peek-agents").getByText(/^Workstream: CA-401 /)).toBeVisible();
  await expect(peek.locator("#peek-agents [data-stage=intake]")).toHaveText("Intake");
  expect((await kept(page)).workstreams?.map((w) => w.itemKey)).toEqual(["CA-401"]);

  // Another ticket has none: the pane goes back to General.
  await peekTicket(page, "CA-402");
  await expect(pipConversation(page)).toHaveText("General");
  await expect(peekSheet(page).getByRole("button", { name: "Start a workstream" })).toBeVisible();
});

test("Open in Pip puts the cursor in the workstream's conversation, and Close, once confirmed, gives the ticket General back", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  const peek = peekSheet(page);
  await expect(pipPane(page).locator("[data-empty-workstream]")).toContainText("CA-401");
  // With Pip already open and the cursor elsewhere, Open in Pip still takes the person there.
  await page.locator("#pip-input").blur();
  await expect(page.locator("#pip-input")).not.toBeFocused();
  await peek.getByRole("button", { name: "Open in Pip" }).click();
  await expect(page.locator("#pip-input")).toBeFocused();

  await peek.getByRole("button", { name: "Close…" }).click();
  const confirm = peek.getByRole("group", { name: "Close this workstream" });
  await expect(confirm).toContainText("Its agents and drafts are kept.");
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);

  await peek.getByRole("button", { name: "Close…" }).click();
  await confirm.getByRole("button", { name: "Close workstream" }).click();
  await expect(pipConversation(page)).toHaveText("General");
  await expect(peek.getByRole("button", { name: "Start a workstream" })).toBeVisible();
  expect(await page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "{}") as { events?: { action: string }[] }).events?.map((e) => e.action), STORE)).toEqual(["opened", "closed"]);
});

test("the palette starts a workstream on the peeked ticket", async ({ page }) => {
  await openApp(page);
  await peekTicket(page, "CA-402");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("start a workstream");
  await palette.getByText("Start a workstream on CA-402", { exact: true }).click();
  await expect(palette).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-402 .+ · Intake$/);
  await expect(peekSheet(page).getByText("Workstream · Intake")).toBeVisible();

  // On a ticket that has one, the palette offers to open it instead.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByLabel("Search commands and tickets").fill("workstream");
  await expect(palette.getByText("Open the workstream on CA-402", { exact: true })).toBeVisible();
  await expect(palette.getByText("Start a workstream on CA-402", { exact: true })).toHaveCount(0);
});

test("a workstream's conversation is apart from General, and both survive a reload", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  await expect(pipConversation(page)).toHaveText("General");
  await askAndWait(page, GENERAL_QUESTION);

  await startWorkstream(page, "CA-401");
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toHaveCount(0);
  await askAndWait(page, WORKSTREAM_QUESTION);

  await peekSheet(page).getByRole("button", { name: "Close details" }).click();
  await expect(peekSheet(page)).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText("General");
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(WORKSTREAM_QUESTION, { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  if (!(await pipPane(page).isVisible())) await openPip(page);
  await expect(pipConversation(page)).toHaveText("General");
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(WORKSTREAM_QUESTION, { exact: true })).toHaveCount(0);

  await peekTicket(page, "CA-401");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Intake$/);
  await expect(pipPane(page).getByText(WORKSTREAM_QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(ANSWER)).toBeVisible();
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toHaveCount(0);
  await expect(peekSheet(page).getByText("Workstream · Intake")).toBeVisible();
});

type Kept = { workstreams?: { id: string; heldReason: string | null }[]; events?: { workstreamId: string; actor: string; action: string; detail: string | null }[] };
const store = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Kept, STORE);

test("a restart holds every open workstream once, a reload doesn't, and a held workstream still answers the person", async ({ page, context }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  expect((await store(page)).workstreams?.map((w) => w.heldReason)).toEqual([null]);

  await page.close();
  const again = await context.newPage();
  await openApp(again);
  const after = await store(again);
  expect(after.workstreams?.map((w) => w.heldReason)).toEqual(["restart"]);
  expect(after.events?.map((e) => [e.actor, e.action, e.detail])).toEqual([
    ["person", "opened", null],
    ["supervisor", "held", "restart"],
  ]);

  // Held, it behaves as before for the person's own question.
  await peekTicket(again, "CA-401");
  await peekSheet(again).getByRole("button", { name: "Open in Pip" }).click();
  await expect(pipConversation(again)).toHaveText(/^Workstream: CA-401 /);
  await askAndWait(again, WORKSTREAM_QUESTION);

  await again.reload();
  await expect(again.getByText("CA-401", { exact: true }).first()).toBeVisible();
  expect((await store(again)).events?.filter((e) => e.action === "held")).toHaveLength(1);
});
