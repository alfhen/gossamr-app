import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, expectPeekInPlace, homeConversation, homeConversationRegion, mockRuns, needsYouTray, openApp, openPipHome, peekSheet, peekTicket, pipHome, startWorkstream, stepChip, stepRail, workstreamRow } from "./support/app";

// A workstream in Manage mode, with pull requests shown only when a test says: the setting the phase's scenarios share.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
/** Pip's run drafts on CA-401 in Pip home's conversation. */
const runCards = (page: Page) => homeConversationRegion(page).getByRole("article", { name: "Start an agent: CA-401" });

/** Waits until Pip has finished answering on Pip home. */
async function settled(page: Page) {
  await expect(pipHome(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

/** Asks Pip for `what` on Pip home and waits for its answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(homeConversationRegion(page).getByText(what, { exact: true }).last()).toBeVisible();
  await settled(page);
}

/** Starts a workstream on CA-401 from its peek, then shows it on Pip home. */
async function homeWorkstream(page: Page) {
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
}

/** Opens the newest run draft's review in place, past the safety sheet a fresh profile shows once at its first agent action. */
async function expandNewest(page: Page) {
  const card = runCards(page).last();
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.getByRole("button", { name: "Review and start", exact: true }).click();
    await expect(card.getByRole("group", { name: "Review and start" }).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
  }
  const review = card.getByRole("group", { name: "Review and start" });
  await expect(card.getByRole("button", { name: "Review and start", exact: true })).toHaveAttribute("aria-expanded", "true");
  return review;
}

/** Reads the newest run draft in place and starts it there; returns its review as shown. */
async function startInline(page: Page) {
  const review = await expandNewest(page);
  await expect(review.locator("[data-inline-prompt]")).toBeVisible();
  const start = review.getByRole("button", { name: "Start agent" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText("Agent started on CA-401.", { exact: false }).last()).toBeVisible();
}

/** Moves run `id` on to done: queued, launching, working, done. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

test("an investigation is reviewed and started in place on Pip home: the exact prompt and checks, then Start, and the rail shows R1 running", async ({ page }) => {
  await openApp(page, MANAGED);
  await homeWorkstream(page);
  await ask(page, "investigate this");
  await expect(runCards(page)).toHaveCount(1);
  const waiting = needsYouTray(page).getByRole("button", { name: /^CA-401 · Start Investigate · / });
  await expect(waiting).toHaveCount(1);
  // The step rail has it under Investigate too.
  await expect(stepChip(page, "investigate").locator("[data-step-needs-you]")).toHaveText("1 needs you");

  const review = await expandNewest(page);
  // The prompt as the backend renders it, read-only, the checks, and the safety lines.
  await expect(review.locator("[data-inline-prompt]")).toContainText("The prompt, the focus note and the ticket text below are exactly what the agent receives.");
  await expect(review.locator("textarea")).toHaveCount(0);
  const rows = review.getByRole("group", { name: "Checks before you approve" }).locator("li[data-level]");
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(rows.first()).toBeVisible();
  await expect(review).toContainText("Agents run as you, with your own Claude settings.");
  const start = review.getByRole("button", { name: "Start agent" });
  await expect(start).toBeEnabled();
  expect(await mockRuns(page)).toEqual([]);

  await start.click();
  // Nothing else opened, and the person is still on Pip home with the workstream selected.
  await expect(setup(page)).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await expect(review).toHaveCount(0);
  await expect(waiting).toHaveCount(0);
  const r1 = (await newest(page, "investigate"))!;
  expect(r1.state).toBe("queued");
  const chip = stepChip(page, "investigate");
  await expect(chip.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(chip.locator("[data-step-state]")).toHaveText("Queued");

  // Launching, then working: the chip follows it.
  await advanceRuns(page, 2, r1.id);
  await expect(chip.locator("[data-step-state]")).toHaveText("Working");
  await expect(chip).toHaveAttribute("data-state", "working");
  // Opened, the chip shows R1's card.
  await chip.getByRole("button", { expanded: false }).first().click();
  await expect(chip.locator(`article[data-run-id="${r1.id}"]`)).toBeVisible();
});

test("a build Pip drafts is never started in place: its 'Review and start →' opens the full setup sheet", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, MANAGED);
  await homeWorkstream(page);
  // The person runs the steps themselves here, so no rule starts one meanwhile.
  const manage = stepRail(page).getByRole("switch", { name: "Manage this workstream" });
  await manage.click();
  await expect(manage).toHaveAttribute("aria-checked", "false");

  await ask(page, "investigate this");
  await startInline(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await ask(page, "plan this");
  await startInline(page);
  await finish(page, (await newest(page, "plan"))!.id);
  await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Ready to review");

  // The plan's description draft opens the ticket's peek over Pip home, where its diff is read and approved as anywhere.
  const rewrite = homeConversationRegion(page).getByRole("article", { name: "Update the description of CA-401" });
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(pipHome(page)).toBeVisible();
  await expect(peekSheet(page).getByRole("article", { name: "Update the description of CA-401" })).toBeFocused();
  await expectPeekInPlace(page);
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).getByRole("button", { name: "Update description" }).click();
  await expect(rewrite).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();

  const before = (await mockRuns(page)).length;
  await ask(page, "build it");
  await expect(homeConversationRegion(page)).toContainText("I drafted a build of CA-401 following plan run");
  const build = runCards(page).last();
  await expect(build.getByRole("button", { name: "Review and start", exact: true })).toHaveCount(0);
  await build.getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await expect(setup(page)).toContainText("This build follows the plan from run");
  await expect(build.getByRole("group", { name: "Review and start" })).toHaveCount(0);
  expect((await mockRuns(page)).length).toBe(before);
});

test("a draft edited elsewhere after it was read in place is refused: the banner, the prompt read again, and Start waits for I've read it", async ({ page }) => {
  await openApp(page, MANAGED);
  await homeWorkstream(page);
  await ask(page, "investigate this");
  const review = await expandNewest(page);
  await expect(review.getByRole("button", { name: "Start agent" })).toBeEnabled();

  // The same draft, changed in the setup sheet from the ticket's peek on the board.
  await page.getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  await peekSheet(page).getByRole("article", { name: "Start an agent: CA-401" }).getByRole("button", { name: /^Review and start/ }).click();
  const field = setup(page).getByRole("textbox", { name: "What the agent should do" });
  await field.fill("Only read the retry loop, changed behind the card.");
  await field.blur();
  await expect(setup(page).getByRole("button", { name: "Start agent" })).toBeEnabled();
  await setup(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(setup(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);

  // Back on Pip home the review is still open, as it was read: Start is refused.
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  const again = runCards(page).last().getByRole("group", { name: "Review and start" });
  await expect(again).not.toContainText("changed behind the card");
  await again.getByRole("button", { name: "Start agent" }).click();
  await expect(again).toContainText("This draft changed. Read it again.");
  await expect(again.locator("[data-inline-prompt]")).toContainText("Only read the retry loop, changed behind the card.");
  await expect(again.getByRole("button", { name: "Start agent" })).toBeDisabled();
  await expect(again).toContainText("Read the change above first");
  expect(await mockRuns(page)).toEqual([]);

  await again.getByRole("button", { name: "I've read it" }).click();
  await expect(again.getByRole("button", { name: "Start agent" })).toBeEnabled();
  await again.getByRole("button", { name: "Start agent" }).click();
  await expect(again).toHaveCount(0);
  await expect.poll(async () => (await mockRuns(page)).length).toBe(1);
  await expect(pipHome(page)).toBeVisible();
});
