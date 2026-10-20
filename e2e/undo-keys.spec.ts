import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPermission, askPip, expectToast, homeComposer, homeConversationRegion, homeSettled, jiraWrites, mockRuns, needOfKind, needsPane, openAgents, openApp, openPip, peekSheet, peekTicket, PIP_INPUT, pipConversation, pipPane, selectWorkstream, startWorkstream, workstreamEvents, workstreamGroup, openNeedOfKind, workstreamSheet } from "./support/app";

// Step 4 of the UX overhaul: less ceremony. Reversible actions (skipping a draft, dismissing a failure, holding a
// workstream, switching it to Advise) act at once and offer Undo for about 8 seconds, instead of asking first; what reaches
// Jira, GitHub or an agent keeps its confirm. One key model in every list (j k move, Enter or o open, a approve, e edit,
// d dismiss or deny, s skip, Esc back), and Cmd/Ctrl+K reaches whatever the focused item's buttons offer.

const MANAGED = "wsManage=1";
const NUDGE_DRAFT = "Draft a comment";

/** The toast on screen, and its Undo button. */
const toast = (page: Page) => page.locator("[data-toast]");
const undo = (page: Page) => toast(page).getByRole("button", { name: "Undo" });

const agentsButton = (page: Page) => page.getByRole("button", { name: /^Agents/ });

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(pipPane(page).locator("[data-pip-conversation]")).toHaveText(/^Workstream: CA-401 /);
}

const actionsOf = async (page: Page) => (await workstreamEvents(page)).map((e) => e.action);

test("s skips a draft at once, with an Undo that brings it back, and the audit says so", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
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
  await openApp(page, `${MANAGED}&runs=empty`);
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

test("holding a workstream offers Undo, and so does switching it to Advise", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  const hold = agentsHome(page).getByRole("button", { name: "Hold", exact: true });
  const banner = pipPane(page).locator("[data-held-banner]");

  await hold.click();
  await expect(banner).toBeVisible();
  await expectToast(page, "Held CA-401.");
  await undo(page).click();
  await expect(banner).toHaveCount(0);
  await expect(hold).toBeVisible();
  await expectToast(page, "CA-401 is free again.");
  const held = await actionsOf(page);
  expect(held.slice(held.indexOf("held"))).toEqual(["held", "undone"]);

  // Resume is the way back from a hold that stands, and it is not undoable: it keeps its one click and offers nothing.
  await hold.click();
  await expect(banner).toBeVisible();
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await agentsHome(page).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect(undo(page)).toHaveCount(0);

  // Manage off is Advise: Undo restores Manage.
  const manage = agentsHome(page).getByRole("switch", { name: "Manage this workstream" });
  await expect(manage).toBeChecked();
  await manage.click();
  await expect(manage).not.toBeChecked();
  await expectToast(page, "Switched CA-401 to Advise.");
  await undo(page).click();
  await expect(manage).toBeChecked();
  const modes = (await workstreamEvents(page)).filter((e) => e.action === "mode_set" || e.action === "undone");
  expect(modes.map((e) => e.action).slice(-2)).toEqual(["mode_set", "undone"]);
});

test("the Agents list takes the same keys: o opens, d dismisses a failure at once with Undo, and d on a permission asks first", async ({ page }) => {
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

  // d on a permission reaches the agent, so it asks for Enter; any other key cancels and nothing is denied.
  const permission = page.locator('main article[data-state="needsPermission"]').first();
  await permission.focus();
  await page.keyboard.press("d");
  await expect(permission.locator("[data-needs-asking]")).toHaveText("↵ deny it; Claude carries on without it · any other key cancels");
  await page.keyboard.press("x");
  await expect(permission.locator("[data-needs-asking]")).toHaveCount(0);
  const id = (await permission.getAttribute("data-run-id"))!;
  expect((await mockRuns(page)).find((r) => r.id === id)?.state).toBe("needsPermission");
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
});

/** Pip's pane open on CA-401's peek, so Pip's drafts land on it, with `n` comment drafts waiting. */
async function commentDrafts(page: Page, n: number) {
  await openApp(page);
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await openPip(page);
  const cards = pipPane(page).getByRole("article", { name: "Comment on CA-401" });
  for (let i = 0; i < n; i++) {
    await askPip(page, NUDGE_DRAFT);
    await expect(cards).toHaveCount(i + 1);
    await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  }
  return cards;
}

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

test("the Activity Drafts list and the ticket's peek take the same keys on their full cards", async ({ page }) => {
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

  // Activity's Drafts list: the same cards, the same keys.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Open drafts");
  await page.keyboard.press("Enter");
  const list = page.getByRole("list", { name: "Drafts waiting for you" });
  const drafts = list.getByRole("article", { name: "Comment on CA-401" });
  await expect(drafts).toHaveCount(2);
  await drafts.first().focus();
  await expect(drafts.first().locator("[data-key-hint]")).toHaveText(/^a approve · e edit · d s skip/);
  await page.keyboard.press("j");
  await expect(drafts.nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(drafts.first()).toBeFocused();
  await page.keyboard.press("d");
  await expect(drafts).toHaveCount(1);
  await expectToast(page, "Skipped the draft on CA-401");
  await undo(page).click();
  await expect(drafts).toHaveCount(2);
  // a asks for Enter on these too: it writes to Jira.
  await drafts.first().focus();
  await page.keyboard.press("a");
  await expect(drafts.first().locator("[data-key-hint]")).toHaveText("↵ approve · any other key cancels");
  await page.keyboard.press("x");
  await expect(drafts.first().locator("[data-key-hint]")).toHaveText(/^a approve/);
  expect(await jiraWrites(page)).toEqual([]);
});

// A permission a Build asks for can be allowed once in Terminal as well as denied; a read-only run's can only be denied.
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });

async function newest(page: Page, kind: string) {
  return (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
}
async function moveTo(page: Page, id: string, state: string, steps: number) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  for (let i = 0; i < steps; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe(state);
}
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** A working Build in a workstream on CA-401 (investigation, triage and plan done, the plan approved), as e2e/decisions.spec.ts gets one. */
async function workingBuild(page: Page) {
  await askPip(page, "investigate this");
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await pipPane(page).getByRole("article", { name: "Start an agent: CA-401" }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
  await moveTo(page, (await newest(page, "investigate"))!.id, "done", 3);
  await moveTo(page, (await started(page, "triage")).id, "done", 3);
  await moveTo(page, (await started(page, "plan")).id, "done", 3);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  const build = await started(page, "build");
  await moveTo(page, build.id, "working", 2);
  return (await mockRuns(page)).find((r) => r.id === build.id)!;
}

test("Cmd/Ctrl+K on a focused permission need offers Allow once and Deny, and Deny goes through to the run", async ({ page }) => {
  await openApp(page, `runs=empty&prSurface=manual&${MANAGED}`);
  await startWorkstream(page, "CA-401");
  const build = await workingBuild(page);
  await askPermission(page, build.id, `approve Bash: git push -u origin worktree-${build.name}`);
  await openAgents(page);
  await openNeedOfKind(page, "permission");
  await expect(needOfKind(page, "permission")).toContainText("R4 wants to run `git push -u origin");
  await workstreamSheet(page).locator('[data-needs-pane][data-kind="permission"] button[data-need-key]').focus();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  // What its buttons offer, first, under "This item".
  const options = palette.getByRole("option");
  await expect(options.nth(0)).toContainText("Allow once");
  await expect(options.nth(1)).toContainText("Deny");
  await expect(palette.getByRole("option", { name: /Open in workstream/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Hold the workstream on CA-401/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Switch CA-401 to Advise/ })).toBeVisible();
  await expect(palette.getByText("This item", { exact: true })).toBeVisible();
  // Typing narrows them as for any command.
  await page.keyboard.type("deny");
  await expect(options.first()).toContainText("Deny");
  expect((await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("needsPermission");
  await page.keyboard.press("Enter");

  // Deny reached the run: Claude carries on without it, and it is audited as the person's.
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("working");
  const denied = (await workstreamEvents(page)).filter((e) => e.action === "permission_denied");
  expect(denied.map((e) => ({ actor: e.actor, runId: e.runId }))).toEqual([{ actor: "person", runId: build.id }]);
  await expect(needOfKind(page, "permission")).toHaveCount(0);
});

test("Cmd/Ctrl+K reaches Hold and Advise for the selected workstream, and 'Approve all safe drafts' shows what it would approve", async ({ page }) => {
  await openApp(page, `${MANAGED}&runs=empty`);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, NUDGE_DRAFT);
  await homeSettled(page);
  await askPip(page, "Draft another comment on this one");
  await homeSettled(page);

  // Focus on the list's row of the workstream: its controls are in the palette, and run what the buttons run.
  await workstreamGroup(page, "CA-401").focus();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.type("hold");
  await palette.getByRole("option", { name: /Hold the workstream on CA-401/ }).click();
  await expect(pipPane(page).locator("[data-held-banner]")).toBeVisible();
  await expectToast(page, "Held CA-401.");
  await undo(page).click();
  await expect(pipPane(page).locator("[data-held-banner]")).toHaveCount(0);

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
