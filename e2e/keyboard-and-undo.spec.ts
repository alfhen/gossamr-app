import { expect, type Page, test } from "@playwright/test";
import {
  advanceRuns, agentsButton, agentsHome, allProjects, askPermission, askPip, expectToast, homeComposer,
  homeConversationRegion, homeSettled, INSTANT_PIP, jiraWrites, keepComments, mockAttached, mockRuns, needOfKind,
  needsPane, openAgents, openApp, openNeedOfKind, openPip, peekSheet, PIP_INPUT, pipConversation, pipPane,
  selectWorkstream, startInvestigationAfterWake, startWorkstream, stepRail, toast, workstreamEvents, workstreamGroup, workstreamOnHome,
  workstreamSheet,
} from "./support/app";

const NUDGE_DRAFT = "Draft a comment";

/** The toast on screen, and its Undo button. */
const undo = (page: Page) => toast(page).getByRole("button", { name: "Undo" });

const actionsOf = async (page: Page) => (await workstreamEvents(page)).map((e) => e.action);

/** Pip's pane open on CA-401's peek, so Pip's drafts land on it, with `n` comment drafts waiting. */
async function commentDrafts(page: Page, n: number) {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await openPip(page);
  const cards = pipPane(page).getByRole("article", { name: "Comment on CA-401" });
  for (let i = 0; i < n; i++) {
    if (i > 0) await keepComments(page);
    await askPip(page, NUDGE_DRAFT);
    await expect(cards).toHaveCount(i + 1);
    await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  }
  return cards;
}

/** A working build in a workstream on CA-401, started by Pip when asked. */
async function workingBuild(page: Page) {
  await askPip(page, "build it");
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  const build = (await mockRuns(page)).find((r) => r.step === "build")!;
  for (let i = 0; i < 2; i++) await advanceRuns(page, 1, build.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("working");
  return (await mockRuns(page)).find((r) => r.id === build.id)!;
}

/** Pauses the workstream on CA-401 from the palette, with the keyboard on its row in the list. */
async function pauseFromPalette(page: Page) {
  await workstreamGroup(page, "CA-401").focus();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("pause");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: /Pause the workstream on CA-401/ }).click();
  await expectToast(page, "Paused CA-401. Resume it to wake Pip there again.");
}

test.describe("Ctrl+0 with a card's button focused", () => {
  test("from a card's own button, and from the card", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();

    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    const card = page.locator("main article[data-run-id]").first();
    await card.focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();
  });

  test("plain keys on a card's button still stay with the button", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await button.focus();
    await page.keyboard.press("j");
    await expect(button).toBeFocused();
  });
});

test("Esc closes only the menu or confirmation that is open: the pane, the peek and the workstream's conversation stay", async ({ page }) => {
  await openApp(page, INSTANT_PIP);
  await startWorkstream(page, "CA-401");
  const more = pipPane(page).getByRole("button", { name: "More for this workstream" });
  const stays = async () => {
    await expect(pipPane(page)).toHaveCount(1);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  };

  // With the ticket's peek open.
  await more.click();
  const stop = pipPane(page).getByRole("menuitem", { name: "Stop the workstream…" });
  await expect(stop).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await stays();
  await expect(more).toBeFocused();

  // The Stop confirmation closes on Esc too, and hands focus back to the menu's button.
  await more.click();
  await stop.click();
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toHaveCount(0);
  await stays();
  await expect(more).toBeFocused();

  // With no peek, where Esc would otherwise close the pane.
  await startInvestigationAfterWake(page);
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(peekSheet(page)).toHaveCount(0);
  await stays();
  await more.click();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("menuitem", { name: "Stop the workstream…" })).toHaveCount(0);
  await stays();
  await expect(more).toBeFocused();
});

test("s skips a draft at once, with an Undo that brings it back, and the audit says so", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, NUDGE_DRAFT);
  await homeSettled(page);
  const card = homeConversationRegion(page).getByRole("article", { name: "Comment on CA-401" });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-state", "pending");

  // The keyboard goes to the draft from the composer; s acts: no ask, no Enter.
  await homeComposer(page).press("ArrowUp");
  await expect(card).toBeFocused();
  await expect(card.locator("[data-key-hint]")).toHaveText("a approve · e edit · d s skip · ↵ open");
  await page.keyboard.press("s");
  await expect(card).toHaveAttribute("data-state", "skipped");
  await expectToast(page, "Skipped the draft on CA-401");
  await expect(undo(page)).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);

  // Undo puts the exact draft back, pending, and its audit keeps both lines.
  await undo(page).click();
  await expect(card).toHaveAttribute("data-state", "pending");
  await expectToast(page, /^The draft on CA-401 is back/);
  const actions = await actionsOf(page);
  expect(actions.slice(actions.indexOf("draft_skipped"))).toEqual(["draft_skipped", "undone"]);
  expect((await workstreamEvents(page)).find((e) => e.action === "undone")).toMatchObject({ actor: "person", detail: "draft_skipped" });

  // Skipping again offers a fresh Undo; the toast goes by itself after a few seconds, and the decision stands.
  await card.focus();
  await page.keyboard.press("d");
  await expect(card).toHaveAttribute("data-state", "skipped");
  await expect(undo(page)).toBeVisible();
  await expect(toast(page)).toHaveCount(0, { timeout: 12_000 });
  await expect(card).toHaveAttribute("data-state", "skipped");
});

test("a on a draft still asks for Enter, since approving writes to Jira; Undo is never offered for it", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, NUDGE_DRAFT);
  await homeSettled(page);
  const card = homeConversationRegion(page).getByRole("article", { name: "Comment on CA-401" });
  await homeComposer(page).press("ArrowUp");
  await expect(card).toBeFocused();
  // The live region is there, empty, before the confirm, and the confirm fills that same node: a new node would often not be read out.
  const live = card.locator("[data-key-live]");
  await expect(live).toHaveText("");
  await live.evaluate((el) => el.setAttribute("data-seen", "before"));
  await page.keyboard.press("a");
  await expect(card.locator("[data-key-hint]")).toHaveText("↵ approve · any other key cancels");
  await expect(card.locator('[data-key-live][data-seen="before"]')).toHaveText("↵ approve · any other key cancels");
  expect(await jiraWrites(page)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  await expect(card).toHaveAttribute("data-state", "applied");
  await expect(undo(page)).toHaveCount(0);
});

test("pausing a workstream says so and needs no Undo: Resume is the way back, and it offers nothing", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  const pause = agentsHome(page).getByRole("button", { name: "Pause", exact: true });
  const banner = pipPane(page).locator("[data-paused-banner]");

  await pause.click();
  await expect(banner).toBeVisible();
  await expectToast(page, "Paused CA-401. Resume it to wake Pip there again.");
  await expect(undo(page)).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await agentsHome(page).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect(pause).toBeVisible();
  await expect(undo(page)).toHaveCount(0);
  const paused = await actionsOf(page);
  expect(paused.slice(paused.indexOf("paused"))).toEqual(["paused", "resumed"]);
});

test("the Agents list takes the same keys: o opens, d dismisses a failure at once with Undo, and d on a permission does nothing", async ({ page }) => {
  await openApp(page);
  await expect(agentsButton(page)).toHaveCount(1);
  await agentsButton(page).click();
  const failed = page.locator('main article[data-state="failed"]').first();
  await expect(failed).toBeVisible();
  await expect(failed.locator("[data-in-needs-you]")).toHaveCount(1);

  // j moves to the next card and the keyboard goes with it; o opens its sheet; Esc is back.
  const cards = page.locator("main article[data-run-id]");
  await cards.first().focus();
  await page.keyboard.press("j");
  await expect(page.locator('main article[aria-current="true"]')).toHaveCount(1);
  await expect(page.locator('main article[aria-current="true"]')).toBeFocused();
  await page.keyboard.press("o");
  const sheet = page.locator("#agent-sheet");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // d on a failure: gone from Needs you at once, with an Undo that puts it back.
  await failed.focus();
  await page.keyboard.press("d");
  await expect(failed.locator("[data-in-needs-you]")).toHaveCount(0);
  await expectToast(page, /Dismissed .* from Needs you\./);
  await undo(page).click();
  await expect(failed.locator("[data-in-needs-you]")).toHaveCount(1);

  // A permission is answered in Terminal: d asks for nothing and denies nothing.
  const permission = page.locator('main article[data-state="needsPermission"]').first();
  await permission.focus();
  await page.keyboard.press("d");
  await expect(permission.locator("[data-needs-asking]")).toHaveCount(0);
  const id = (await permission.getAttribute("data-run-id"))!;
  expect((await mockRuns(page)).find((r) => r.id === id)?.state).toBe("needsPermission");
});

test("draft cards in the conversation: j and k move, d skips at once and Undo restores it", async ({ page }) => {
  const cards = await commentDrafts(page, 2);
  const [first, second] = [cards.nth(0), cards.nth(1)];
  await page.locator(PIP_INPUT).press("ArrowUp");
  await expect(second).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await page.keyboard.press("j");
  await expect(second).toBeFocused();
  await page.keyboard.press("k");
  await expect(first).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("d");
  await expect(second).toHaveAttribute("data-state", "skipped");
  await expectToast(page, "Skipped the draft on CA-401");
  await undo(page).click();
  await expect(second).toHaveAttribute("data-state", "pending");
  await expect(first).toHaveAttribute("data-state", "pending");
});

test("draft cards in the ticket peek take the same keys", async ({ page }) => {
  const pending = await commentDrafts(page, 2);
  await expect(pending).toHaveCount(2);

  // The ticket's peek: a draft card is a stop of its own; e opens its editing, s skips, Undo restores.
  const inPeek = peekSheet(page).getByRole("article", { name: "Comment on CA-401" });
  await expect(inPeek).toHaveCount(2);
  await inPeek.first().focus();
  await expect(inPeek.first().locator("[data-key-hint]")).toHaveText(/^a approve · e edit · d s skip/);
  await page.keyboard.press("e");
  await expect(inPeek.first().locator("textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await inPeek.first().focus();
  await page.keyboard.press("j");
  await expect(inPeek.nth(1)).toBeFocused();
  await page.keyboard.press("s");
  await expect(inPeek).toHaveCount(1);
  await undo(page).click();
  await expect(inPeek).toHaveCount(2);
  await toast(page).getByRole("button", { name: "Dismiss" }).click().catch(() => undefined);


});

test("Cmd/Ctrl+K on a focused permission need offers Open in Terminal, and it opens the run there", async ({ page }) => {
  await openApp(page, "runs=empty&prSurface=manual");
  await startWorkstream(page, "CA-401");
  const build = await workingBuild(page);
  await askPermission(page, build.id, `approve Bash: git push -u origin worktree-${build.name}`);
  await openAgents(page);
  await openNeedOfKind(page, "permission");
  await expect(needOfKind(page, "permission")).toContainText("wants to run `git push -u origin");
  await workstreamSheet(page).locator('[data-needs-pane][data-kind="permission"] button[data-need-key]').focus();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  // What its button offers, first, under "This item".
  const options = palette.getByRole("option");
  await expect(options.nth(0)).toContainText("Open in Terminal");
  await expect(palette.getByRole("option", { name: /Open in workstream/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Pause the workstream on CA-401/ })).toBeVisible();
  await expect(palette.getByText("This item", { exact: true })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Deny|Allow once/ })).toHaveCount(0);
  await page.keyboard.press("Enter");

  // The run is opened in Terminal for the person to answer there; nothing was answered for them.
  await expect.poll(async () => await mockAttached(page)).toEqual([build.id]);
  expect((await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("needsPermission");
  expect((await workstreamEvents(page)).filter((e) => e.action.startsWith("permission"))).toEqual([]);
});

test("F6 reaches the toast on screen, Esc dismisses it and gives the keyboard back", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "runs=empty");
  await workstreamOnHome(page);
  await pauseFromPalette(page);
  const onToast = () => page.evaluate(() => !!document.activeElement?.closest("[data-toast]"));
  // F6 goes round the regions; the toast is one of them while it shows.
  for (let n = 0; n < 12 && !(await onToast()); n++) await page.keyboard.press("F6");
  expect(await onToast()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(toast(page)).toHaveCount(0);
  // The keyboard is not lost to the page itself.
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);
});

test("'Open in workstream' on a paused need puts the keyboard on the banner's Resume", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "runs=empty");
  await workstreamOnHome(page);
  await pauseFromPalette(page);
  await openNeedOfKind(page, "paused");
  await workstreamSheet(page).locator('[data-needs-pane][data-kind="paused"] button[data-need-key]').focus();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("open in workstream");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: /Open in workstream/ }).click();
  await expect(page.locator("[data-paused-banner] button:focus")).toHaveText("Resume");
});

test("Cmd/Ctrl+K reaches Pause for the selected workstream, and 'Approve all safe drafts' shows what it would approve", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, NUDGE_DRAFT);
  await homeSettled(page);
  await keepComments(page);
  await askPip(page, "Draft another comment on this one");
  await homeSettled(page);

  // Focus on the list's row of the workstream: its controls are in the palette, and run what the buttons run.
  await workstreamGroup(page, "CA-401").focus();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.type("pause");
  await palette.getByRole("option", { name: /Pause the workstream on CA-401/ }).click();
  await expect(pipPane(page).locator("[data-paused-banner]")).toBeVisible();
  await expectToast(page, "Paused CA-401. Resume it to wake Pip there again.");
  await pipPane(page).locator("[data-paused-banner]").getByRole("button", { name: "Resume" }).click();
  await expect(pipPane(page).locator("[data-paused-banner]")).toHaveCount(0);

  // The global entry opens the list's own combined preview and its confirm: nothing is approved by choosing it.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("approve all safe");
  await palette.getByRole("option", { name: /Approve all safe drafts in CA-401/ }).click();
  // It opens in the decision pane, like any other decision.
  const preview = needsPane(page).locator("[data-needs-you-batch-preview]");
  await expect(preview).toBeVisible();
  await expect(agentsHome(page).getByRole("group", { name: "Approve 2 drafts" })).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);
  await agentsHome(page).getByRole("button", { name: "Yes, approve 2" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
});

test("Ctrl+Z with nothing to undo says so", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await openAgents(page);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-toast]").filter({ hasText: "Nothing to undo." })).toBeVisible();
});

test.describe("toasts leave with the page and clear the launcher", () => {
  test("one without Undo is dismissed when the route changes", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const rail = stepRail(page);
    await rail.getByRole("button", { name: "Close…" }).click();
    await rail.getByRole("button", { name: "Close workstream" }).click();
    await expect(toast(page)).toContainText("Closed the workstream on CA-408");
    // Close has an Undo now; the toast that says it was undone has none.
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Reopened the workstream on CA-408");
    await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    // A toast younger than the route grace (500 ms) is taken to come with the change and stays; leave it older than that.
    await page.waitForTimeout(700);
    await allProjects(page);
    await expect(agentsHome(page)).toHaveCount(0);
    await expect(toast(page)).toHaveCount(0);
  });

  test("on the workspace a toast stands above the Pip launcher, not over it", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    // A toast over the workspace (here, from drafting a ticket in the palette) clears the launcher's box.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("New ticket");
    await page.getByRole("option", { name: /^New ticket/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    if (await dialog.getByRole("option").count()) await dialog.getByRole("option").first().click();
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("Check the toast");
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText("Drafted a new ticket");
    const t = (await toast(page).boundingBox())!;
    // Neither the launcher's box nor the thread its spider hangs from.
    const thread = (await launcher.locator(".pip-thread").boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual((await launcher.boundingBox())!.y);
    expect(t.y + t.height).toBeLessThanOrEqual(thread.y);
  });
});
