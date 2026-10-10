import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  agentsSettled,
  expectPeekInPlace,
  expectVisibleFocus,
  finishOnHome,
  homeComposer,
  homeConversation,
  homeConversationRegion,
  homeRunCards,
  homeSettled,
  inlineStart,
  jiraWrites,
  mockRuns,
  needsYouTray,
  openApp,
  peekSheet,
  pipHome,
  scriptNextRun,
  setBudget,
  stepChip,
  surfacePullRequests,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

// A workstream in Manage mode, with pull requests shown only when a test says: the setting the phase's scenarios share.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string, after: string | null = null) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBe(after);
  return (await newest(page, kind))!;
}


/** Presses `key` and checks the focus that results is visible. */
async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  return expectVisibleFocus(page);
}

/** Presses `key` until `target` has focus, at most `max` times, checking the focus ring at each step. */
async function pressUntil(page: Page, key: string, target: Locator, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await press(page, key);
  }
  await expect(target).toBeFocused();
}

/** Runs a palette command from the keyboard: Cmd/Ctrl+K, the query, then Enter on the first entry named `name`. */
async function palette(page: Page, query: string, name: string | RegExp) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const option = dialog.getByRole("option", { name }).first();
  await expect(option).toBeVisible();
  for (let i = 0; i < 20 && (await option.getAttribute("aria-selected")) !== "true"; i++) await page.keyboard.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
}

const chipButton = (page: Page, kind: string) => stepChip(page, kind).locator("[data-step-chip]");

test("keyboard only, intake to review on Pip home: columns with F6, rows and steps with j and k, the draft from the composer, inline start, the plan in the peek and the review's comments together", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page, MANAGED);
  await agentsSettled(page);

  // The ticket from the palette, then its workstream.
  await palette(page, "CA-401", /CA-401/);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await palette(page, "start a workstream", "Start a workstream on CA-401");
  await expect.poll(async () => (await workstreamEvents(page)).length).toBeGreaterThan(0);
  await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 12 });
  await page.keyboard.press("Escape");

  // Pip home; the list with Shift+F6 from the conversation, then j to the workstream and Enter.
  await page.keyboard.press("ControlOrMeta+0");
  await expect(homeConversation(page)).toHaveText("General");
  await press(page, "Shift+F6");
  await expect(workstreamRow(page, "General")).toBeFocused();
  await press(page, "j");
  await expect(workstreamRow(page, "CA-401")).toBeFocused();
  await press(page, "k");
  await expect(workstreamRow(page, "General")).toBeFocused();
  await press(page, "j");
  await press(page, "Enter");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await expect(homeComposer(page)).toBeFocused();

  // j and k are text in the composer.
  await page.keyboard.type("jk");
  await expect(homeComposer(page)).toHaveValue("jk");
  await expect(homeComposer(page)).toBeFocused();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Investigate CA-401");
  await page.keyboard.press("Enter");
  await homeSettled(page);
  await expect(homeRunCards(page, "CA-401")).toHaveCount(1);

  // ArrowUp from the empty composer to the draft, Enter opens its review in place, Tab to Start and Enter.
  const card = homeRunCards(page, "CA-401").last();
  await press(page, "ArrowUp");
  await expect(card).toBeFocused();
  const review = await inlineStart(page, card, "keyboard", async () => {
    await page.keyboard.press("ControlOrMeta+j");
    await page.keyboard.press("ArrowUp");
    await expect(card).toBeFocused();
  });
  const start = review.getByRole("button", { name: "Start agent" });
  await expect(start).toBeEnabled();
  await pressUntil(page, "Tab", start);
  await press(page, "Enter");
  await expect(review).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();
  const r1 = (await newest(page, "investigate"))!;

  // The rules take it to a finished plan.
  await finishOnHome(page, r1.id);
  await finishOnHome(page, (await started(page, "triage")).id);
  await finishOnHome(page, (await started(page, "plan")).id);
  await homeSettled(page);

  // F6 to the rail, j to Plan, Enter opens it, j down to the description draft and Enter opens the peek.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(homeComposer(page)).toBeFocused();
  await press(page, "F6");
  await expect(chipButton(page, "investigate")).toBeFocused();
  await pressUntil(page, "j", chipButton(page, "plan"));
  await press(page, "Enter");
  await expect(chipButton(page, "plan")).toHaveAttribute("aria-expanded", "true");
  const rewrite = stepChip(page, "plan").getByRole("article", { name: "Update the description of CA-401" });
  await pressUntil(page, "j", rewrite, 10);
  await press(page, "Enter");
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(pipHome(page)).toBeVisible();
  // The keyboard goes into the peek with it, onto the draft, and its approve is a few Tabs on.
  const inPeek = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await expect(inPeek).toBeFocused();
  await expectVisibleFocus(page);
  await expectPeekInPlace(page);
  const approve = inPeek.getByRole("button", { name: "Update description" });
  await pressUntil(page, "Tab", approve, 6);
  // The draft leaves the peek once approved; the keyboard stays in the peek, on what comes next there.
  await press(page, "Enter");
  await expect(rewrite).toHaveCount(0);
  await expect(inPeek).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#peek-sheet"))).toBe(true);
  expect((await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["rewrite", "CA-401"]]);
  // Esc closes the peek, and the keyboard is back on the rail where it opened from.
  await press(page, "Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  await expect(chipButton(page, "plan")).toBeFocused();

  // Build, its pull request, a blocking review, the fix round and a passing review: the rules again.
  const r4 = await started(page, "build");
  await finishOnHome(page, r4.id);
  await expect(stepChip(page, "build").locator("[data-step-state]")).toHaveText("waiting for PR");
  await surfacePullRequests(page);
  // The draft pull request shows on the rail, and the chip stops waiting for it.
  await expect(stepChip(page, "build").locator("[data-step-pr]")).toHaveText(/^Draft PR#\d+ CA-401: /);
  await expect(stepChip(page, "build").locator("[data-step-state]")).not.toHaveText("waiting for PR");
  const r5 = await started(page, "review");
  await finishOnHome(page, r5.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r4.id)?.state).toBe("working");
  await finishOnHome(page, r4.id);
  await surfacePullRequests(page);
  const r6 = await started(page, "review", r5.id);
  await scriptNextRun(page, "review", { verdict: "pass" });
  await finishOnHome(page, r6.id);
  await expect(stepChip(page, "review").locator("[data-step-verdict]")).toHaveText("· Pass");
  await homeSettled(page);

  // Back to the rail, k or j to Review, Enter, Tab to 'Approve these 2', Enter, and Enter on the confirm.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(homeComposer(page)).toBeFocused();
  await press(page, "F6");
  await pressUntil(page, "j", chipButton(page, "review"));
  await press(page, "Enter");
  await expect(chipButton(page, "review")).toHaveAttribute("aria-expanded", "true");
  const together = stepChip(page, "review").getByRole("button", { name: "Approve these 2" });
  await pressUntil(page, "Tab", together, 20);
  await press(page, "Enter");
  const yes = stepChip(page, "review").getByRole("button", { name: "Yes, approve 2" });
  await expect(yes).toBeFocused();
  await expectVisibleFocus(page);
  // Esc cancels and goes back to the button, with nothing written.
  await press(page, "Escape");
  await expect(together).toBeFocused();
  expect((await jiraWrites(page)).length).toBe(1);
  await press(page, "Enter");
  await press(page, "Enter");
  await expect(stepChip(page, "review").locator("[data-batch-outcome]")).toHaveText("Approved 2.");
  await expect.poll(async () => (await jiraWrites(page)).filter((w) => w.type === "comment").length).toBe(2);
});

test("j and k move through the list and the tray and stop at the ends; Enter on a tray item goes to its card", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page);
  await palette(page, "CA-401", /CA-401/);
  await palette(page, "start a workstream", "Start a workstream on CA-401");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+0");
  await expect(homeConversation(page)).toHaveText("General");

  // Into the workstream from the list, and Pip drafts an investigation there; it waits in the tray.
  await press(page, "Shift+F6");
  await press(page, "j");
  await press(page, "Enter");
  await page.keyboard.type("Investigate CA-401");
  await page.keyboard.press("Enter");
  await homeSettled(page);
  const item = needsYouTray(page).locator("[data-needs-you-item]").first();
  await expect(item).toBeVisible();

  // From the list: k stops at General, j runs on into the tray and stops at its last item.
  await press(page, "Shift+F6");
  await expect(workstreamRow(page, "CA-401")).toBeFocused();
  await press(page, "k");
  await press(page, "k");
  await expect(workstreamRow(page, "General")).toBeFocused();
  await press(page, "j");
  await press(page, "j");
  await expect(item).toBeFocused();
  await press(page, "j");
  await expect(item).toBeFocused();
  // Enter goes to the draft's card in the conversation.
  await page.keyboard.press("Enter");
  await expect(homeRunCards(page, "CA-401").last()).toBeFocused();
  await expectVisibleFocus(page);

  // The rail with Cmd/Ctrl+], wrapping round with Cmd/Ctrl+[ and ], and nothing moves while the palette is open.
  await press(page, "ControlOrMeta+BracketRight");
  await expect(chipButton(page, "investigate")).toBeFocused();
  await press(page, "ControlOrMeta+BracketRight");
  await expect(workstreamRow(page, "CA-401")).toBeFocused();
  await press(page, "ControlOrMeta+BracketLeft");
  await expect(chipButton(page, "investigate")).toBeFocused();
  // Space opens a chip, and Enter closes it again.
  await press(page, "Space");
  await expect(chipButton(page, "investigate")).toHaveAttribute("aria-expanded", "true");
  await press(page, "Enter");
  await expect(chipButton(page, "investigate")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("j");
  await expect(page.getByRole("combobox")).toHaveValue("j");
  await page.keyboard.press("Escape");
  await expect(homeConversationRegion(page)).toBeVisible();
});
