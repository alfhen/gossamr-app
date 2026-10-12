import { expect, test, type Page } from "@playwright/test";
import {
  expandNeedsYou,
  expectToast,
  homeConversationRegion,
  jiraWrites,
  mockRuns,
  needRow,
  needsPane,
  needsYouCount,
  needsYouTray,
  openApp,
  openPip,
  openPipHome,
  peekSheet,
  peekTicket,
  pipHome,
  pipPane,
  landOnWorkspace,
  reviewedDraft,
  PIP_INPUT,
} from "./support/app";

// Fixes from the second dogfood round: counts that agree, keys that work after a skip, Esc and F6 in the workspace layout,
// and the copy and scroll fixes on the safety sheet, the review card and the plan.

const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runSheet = (page: Page) => page.getByRole("dialog", { name: "Agent run" });
const railButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();

/** Whether the focused element sits inside `selector`. */
const focusIn = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

/** Opens the peek's Agent menu on CA-401 and picks Investigate, which shows the one-time safety sheet on a fresh profile. */
async function investigateFromPeek(page: Page) {
  await peekTicket(page, "CA-401");
  await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
  await expect(safety(page)).toBeVisible();
}

test.describe("counts that mean one thing (D4, D5, N3)", () => {
  test("Needs you's one count is the same on Pip home, the rail, the composer and the Agents header; the timeline lists every agent once", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await expect(needsYouTray(page).locator("[data-needs-you-group]").first()).toBeVisible();
    const count = await needsYouCount(page).innerText();
    expect(Number(count)).toBeGreaterThan(0);
    // The list's pill, the footer and the Pip home badge are one number.
    await expect(pipHome(page).locator("[data-composer-footer]")).toContainText(`${count} ${count === "1" ? "needs" : "need"} you`);
    await expect(railButton(page, /^Pip home/)).toHaveAccessibleName(`Pip home, ${count} ${count === "1" ? "thing needs" : "things need"} you`);
    // Agents has no badge: what its runs need is in that count, once.
    await expect(railButton(page, /^Agents/)).toHaveAccessibleName("Agents");
    // The timeline: a row for every run at work or waiting on the person, each once.
    const listed = new Set(["needsAnswer", "needsPermission", "systemBlocked", "failed", "queued", "launching", "working"]);
    const agents = (await mockRuns(page)).filter((r) => listed.has(r.state)).length;
    const live = homeConversationRegion(page).locator('[data-kind="run"]:is([data-phase="queued"], [data-phase="started"], [data-phase="waiting"], [data-phase="failed"])');
    await expect(live).toHaveCount(agents);
    // The Agents header says the same count, and nothing opening Agents does moves it.
    await railButton(page, /^Agents/).click();
    const header = page.locator("main header").filter({ has: page.getByRole("heading", { name: "Agents" }) });
    await expect(header).toContainText(new RegExp(`^Agents${count} ${count === "1" ? "needs" : "need"} you · `));
    await expect(railButton(page, /^Pip home/)).toHaveAccessibleName(`Pip home, ${count} ${count === "1" ? "thing needs" : "things need"} you`);
    await expect(railButton(page, /^Agents/)).toHaveAccessibleName("Agents");
    // Failed or stuck in the header is the lane of that name, card for card (N3).
    const bad = await page.locator('[data-lane="bad"] article[data-run-id]').count();
    expect(bad).toBeGreaterThan(1);
    await expect(header).toContainText(`${bad} failed or stuck`);
    // Stop all counts a set of its own, and says so.
    await page.getByRole("button", { name: "Safety and settings" }).click();
    await expect(safety(page).getByRole("button", { name: /^Stop all \(\d+ stoppable\)$/ })).toBeVisible();
  });

  test("Needs you rows for tickets outside the watched projects still read KEY · Title (D27)", async ({ page }) => {
    await openApp(page, "runs=failures");
    await openPipHome(page);
    await expandNeedsYou(page);
    const heads = needsYouTray(page).locator('[data-needs-you-need][data-kind="failure"], [data-needs-you-need][data-kind="permission"]').locator("[data-needs-you-head]");
    await expect(heads.first()).toBeVisible();
    const texts = await heads.allTextContents();
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(t).toMatch(/^[A-Z]+-\d+ · \S/);
    expect(texts).toContain("SUP-9 · Export timeout");
  });
});

test.describe("draft keys after a skip (N1)", () => {
  test("s skips a draft at once, and the next one takes its keys at once: a opens it and Enter approves it", async ({ page }) => {
    await openApp(page, "pipRun=1");
    await openPipHome(page);
    // General's timeline holds the drafts waiting, among its other entries.
    const waiting = homeConversationRegion(page).locator("[data-timeline]");
    const start = waiting.getByRole("article", { name: "Start an agent: CA-402" });
    const rewrite = waiting.getByRole("article", { name: "Update the description of CA-401" });
    await expect(start).toBeVisible();
    await page.locator(PIP_INPUT).focus();
    for (let i = 0; i < 8 && !(await start.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowUp");
    await expect(start).toBeFocused();
    await page.keyboard.press("s");
    await expect(start).toHaveCount(0);
    // The next draft has the keyboard, armed: its hint shows, and its keys work without a Shift+Tab and Tab first.
    await expect(rewrite).toBeFocused();
    await expect(rewrite.getByRole("status")).toHaveText(/↵ open$/);
    await page.keyboard.press("a");
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
    const inPeek = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    const update = inPeek.getByRole("button", { name: "Update description" });
    for (let i = 0; i < 12 && !(await update.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(update).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(inPeek).toHaveCount(0);
    await expect.poll(async () => (await jiraWrites(page)).length).toBeGreaterThan(0);
  });
});

test.describe("Esc and F6 in the workspace layout (N4, D29)", () => {
  test("Esc in Pip's composer closes the peek over it first, then Pip", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-403");
    await openPip(page);
    const input = pipPane(page).locator(PIP_INPUT);
    await input.focus();
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await expect(pipPane(page)).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pipPane(page)).toHaveCount(0);
  });

  test("F6 steps between the list, the peek and Pip; Tab past the pane's last button goes on to the next region, never the page", async ({ page }) => {
    await openApp(page);
    await peekTicket(page, "CA-403");
    await openPip(page);
    const input = pipPane(page).locator(PIP_INPUT);
    await input.focus();
    await page.keyboard.press("F6");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("workspace-main");
    await page.keyboard.press("F6");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("F6");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("Shift+F6");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("workspace-main");

    // Tab from the composer: Commands, then on to the next region rather than the page itself.
    await input.focus();
    await page.keyboard.press("Tab");
    await expect(pipPane(page).getByRole("button", { name: "Commands", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? null, id: document.activeElement?.id ?? null }));
    expect(at.tag).not.toBe("BODY");
    expect(at.id).toBe("workspace-main");
  });
});

test.describe("the one-time safety sheet (D25, N2)", () => {
  test("on the first action it shows the three lines and Got it, continue, with the rest folded and nothing said twice", async ({ page }) => {
    await openApp(page, "runs=empty");
    await investigateFromPeek(page);
    const sheet = safety(page);
    await expect(sheet.locator("[data-safety-summary] li")).toHaveCount(3);
    await expect(sheet.getByRole("button", { name: "Got it, continue" })).toBeInViewport();
    const details = sheet.locator("details[data-safety-details]");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(sheet.getByText("Stop everything")).toBeHidden();
    const text = (await sheet.textContent()) ?? "";
    expect(text.match(/not (?:a )?locks?\b/g)).toHaveLength(1);
    expect(text.match(/Investigate, Triage, Plan, Review and Verify/g)).toHaveLength(1);
    await details.locator("summary").click();
    await expect(sheet.getByRole("heading", { name: "What a Build may touch" })).toBeVisible();
  });

  test("closing it with × cancels the action and says so; nothing was started", async ({ page }) => {
    await openApp(page, "runs=empty");
    await investigateFromPeek(page);
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
    await expectToast(page, "Cancelled: Investigate CA-401. Nothing was started.");
    await expect(setup(page)).toHaveCount(0);
    expect(await mockRuns(page)).toEqual([]);
  });
});

test.describe("a queued run (N8)", () => {
  test("can be cancelled from its sheet before it launches, with its own confirmation", async ({ page }) => {
    await landOnWorkspace(page);
    await page.goto("/?runs=empty&mockRepos=14");
    await page.getByRole("button", { name: "Start watching" }).click();
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await investigateFromPeek(page);
    await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    await setup(page).getByRole("combobox", { name: "Repository" }).selectOption("acme/webshop");
    await setup(page).getByRole("button", { name: "Start agent" }).click();
    await expect(setup(page)).toHaveCount(0);
    await expect.poll(async () => (await mockRuns(page)).map((r) => r.state)).toEqual(["queued"]);
    const [queued] = await mockRuns(page);
    await railButton(page, /^Agents/).click();
    await page.locator(`main article[data-run-id="${queued.id}"]`).click();
    await expect(runSheet(page)).toBeVisible();
    await runSheet(page).getByRole("button", { name: "Cancel", exact: true }).click();
    const ask = runSheet(page).getByRole("group", { name: "Cancel this run" });
    await expect(ask).toContainText("Cancel this run? It hasn't started, so nothing is lost.");
    await ask.getByRole("button", { name: "Yes, cancel" }).click();
    await expect.poll(async () => (await mockRuns(page)).map((r) => r.state)).toEqual(["stopped"]);
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
  });
});

test.describe("agent cards and help (N9, N12)", () => {
  test("a card just answered says something of its own after Working, never Working again", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await expandNeedsYou(page);
    const asking = (await mockRuns(page)).find((r) => r.key === "CA-409" && r.state === "needsAnswer")!;
    await needRow(page, /CA-409.*asks a question/).click();
    await needsPane(page).getByRole("textbox", { name: "Your answer" }).fill("Yes, keep the old rounding for refunds.");
    await needsPane(page).getByRole("button", { name: "Send answer" }).click();
    await expect(needRow(page, /CA-409/)).toHaveCount(0);
    const card = homeConversationRegion(page).locator(`[data-timeline-entry] article[data-run-id="${asking.id}"]`);
    await expect(card).toContainText("Working");
    await expect(card).not.toContainText(/Working\s*·\s*Working/);
  });

  test("Pip home's Commands help says where a run's id is, since its cards show none", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await pipHome(page).getByRole("button", { name: "Commands", exact: true }).click();
    await expect(pipHome(page).getByRole("dialog", { name: "Commands" })).toContainText("A run's id is on its card in Agents");
  });
});

test.describe("the review card (N5, N7, D21)", () => {
  test("opened in place from Pip home, its title and state show under the sticky bar, and its first comment box above its action row", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await reviewedDraft(page);
    await peekSheet(page).getByRole("button", { name: "Close details" }).click();
    await expect(peekSheet(page)).toHaveCount(0);
    await openPipHome(page);
    const card = homeConversationRegion(page).getByRole("article", { name: /GitHub review/ }).first();
    await expect(card).toBeVisible();
    await card.focus();
    await page.keyboard.press("Enter");
    const review = peekSheet(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
    await expect(review).toBeVisible();
    await expect.poll(() => focusIn(page, '#peek-sheet article[data-github-review]')).toBe(true);
    const bar = peekSheet(page).locator("button, div", { hasText: /^Drafts waiting/ }).last();
    const head = review.locator("> div").first();
    await expect.poll(async () => (await head.boundingBox())!.y >= (await bar.boundingBox())!.y + (await bar.boundingBox())!.height - 1).toBe(true);
    const first = review.getByRole("textbox", { name: /^Comment on / }).first();
    const actions = review.locator("[data-draft-actions]");
    await expect.poll(async () => (await first.boundingBox())!.y < (await actions.boundingBox())!.y).toBe(true);
  });

  test("once posted, says where and at which commit it went, not to read and edit it before posting", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.locator("[data-provenance=run]")).toContainText("read and edit it before you post");
    await review.getByRole("button", { name: "Post review" }).click();
    await expect(review.locator("[data-provenance=run]")).toContainText(/Posted to acme\/webshop#218 at [0-9a-f]{8}, as a comment review\./);
    await expect(review).not.toContainText("read and edit it before you post");
    await expect(review).not.toContainText("Nothing goes to GitHub until you post it here.");
  });
});

