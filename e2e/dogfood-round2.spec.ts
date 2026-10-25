import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, showWorkspace, mockRuns, openAgents, openApp, openPip, peekSheet, peekTicket, PIP_INPUT, pipPane, reviewedDraft, needsStack } from "./support/app";

// Fixes from the second dogfood round: counts that agree, keys that work after a skip, Esc and F6 in the workspace layout,
// and the copy and scroll fixes on the review card and the plan.

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runSheet = (page: Page) => page.getByRole("dialog", { name: "Agent run" });
const railButton = (page: Page, name: RegExp) => page.locator("[data-rail]").getByRole("button", { name }).first();

/** Whether the focused element sits inside `selector`. */
const focusIn = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

/** Opens the peek's Agent menu on CA-401 and picks Investigate, which opens the setup sheet. */
async function investigateFromPeek(page: Page) {
  await peekTicket(page, "CA-401");
  await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
  await expect(setup(page)).toBeVisible();
}

test.describe("counts that mean one thing (D4, D5, N3)", () => {
  test("Needs you rows for tickets outside the watched projects still read KEY · Title (D27)", async ({ page }) => {
    await openApp(page, "runs=failures");
    await openAgents(page);
    await expandNeedsYou(page);
    const heads = needsStack(page).locator('[data-needs-pane][data-kind="failure"], [data-needs-pane][data-kind="permission"]').locator("[data-needs-pane-head]");
    await expect(heads.first()).toBeVisible();
    const texts = await heads.allTextContents();
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(t).toMatch(/^[A-Z]+-\d+ · \S/);
    expect(texts).toContain("SUP-9 · Export timeout");
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

test.describe("a queued run (N8)", () => {
  test("can be cancelled from its sheet before it launches, with its own confirmation", async ({ page }) => {
    await page.goto("/?runs=empty&mockRepos=14");
    await page.getByRole("button", { name: "Start watching" }).click();
    await showWorkspace(page);
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await investigateFromPeek(page);
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

test.describe("the review card (N5, N7, D21)", () => {
  test("once posted, says where and at which commit it went, not to read and edit it before posting", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.locator("[data-provenance=run]")).toContainText("read and edit it before you post");
    await review.getByRole("button", { name: "Post review" }).click();
    await expect(review.locator("[data-provenance=run]")).toContainText(/Posted to acme\/webshop#218 at [0-9a-f]{8}, as a comment review\./);
    await expect(review).not.toContainText("read and edit it before you post");
    await expect(review).not.toContainText("Nothing goes to GitHub until you post it here.");
  });
});

