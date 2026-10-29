import { expect, type Page, test } from "@playwright/test";
import {
  activeIsBody, advanceRuns, agentsHome, allProjects, askPermission, askPip, editTicket, expectToast, homeComposer,
  homeConversation, homeConversationRegion, homeSettled, INSTANT_PIP, jiraWrites, MANUAL_PRS, mockRuns, needsPane,
  needsYouCount, openAgents, openApp, openPip, paneSettled, pausedBanner, peekSheet, peekTicket, pipConversation,
  pipPane, selectWorkstream, showWorkspace, startInvestigationAfterWake, startWorkstream, stepRail, surfacePullRequests, toast, VAGUE_TICKET, wakes,
  wakeTurns, workstreamEvents, workstreamGroup, workstreamOpen,
} from "./support/app";
import { finishRun, newest } from "./support/steps";

/** The line under the workstream's controls in the Pip pane. */
const nextLine = (page: Page) => pipPane(page).locator("[data-next-step]");

/** Asks Pip for an investigation of CA-401, which starts it. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);

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

type Kept = { workstreams?: { id: string; pausedReason: string | null }[]; events?: { workstreamId: string; actor: string; action: string; detail: string | null }[] };

const store = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Kept, STORE);

test.describe("Pause, Resume and Close…", () => {
  test("Pause lands on Resume, Resume on Pause, and Tab stays between Close workstream and Keep", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(controls.getByRole("button", { name: "Resume" })).toBeFocused();
    await controls.getByRole("button", { name: "Resume" }).click();
    await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await expect(ask).toHaveAttribute("aria-describedby", /\S+ \S+/);
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Close workstream" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
  });

  test("the paused banner is not a live region that holds buttons", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(controls.locator("[data-paused-banner]")).toHaveAttribute("role", "group");
    expect(await page.locator('[role="status"]:not([data-toast-host])').evaluateAll((els) => els.filter((el) => el.querySelector("button")).map((el) => el.outerHTML.slice(0, 160)))).toEqual([]);
  });
});

test.describe("the composer per workstream", () => {
  test("keeps unsent text with its own workstream and never sends it from another", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await homeComposer(page).fill("half a thought about 408");
    await selectWorkstream(page, "CA-402");
    await expect(homeComposer(page)).toHaveValue("");
    await homeComposer(page).fill("something for 402");
    await selectWorkstream(page, "CA-408");
    await expect(homeComposer(page)).toHaveValue("half a thought about 408");
    await selectWorkstream(page, "CA-402");
    await expect(homeComposer(page)).toHaveValue("something for 402");
  });
});

test.describe("closing a workstream", () => {
  test("closing a workstream takes it off the list and back to General, and the conversation's name is a heading", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(pipPane(page).getByRole("heading", { level: 2, name: /Workstream: CA-401/ })).toBeVisible();
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(0);
    await expect(pipPane(page).getByRole("heading", { level: 2, name: "General" })).toBeVisible();
  });
});

test("while a run works, the header says Pip is woken when it finishes", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await advanceRuns(page, 2, r1.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r1.id)?.state).toBe("working");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "running");
  await expect(nextLine(page)).toHaveText("Next: when R1 (Investigator) finishes, Pip is woken to decide what comes next.");
  await expect(nextLine(page).locator("button")).toHaveCount(0);
});

test("paused, the header says so and that Resume continues", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
  await pipPane(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "paused");
  await expect(nextLine(page)).toHaveText("Next: paused. Resume to continue.");

  await pipPane(page).getByRole("button", { name: "Resume" }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
});

test("waiting on the person, the header links to the top need and opens it in the Needs-you pane", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await advanceRuns(page, 2, r1.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r1.id)?.state).toBe("working");

  await askPermission(page, r1.id, "approve Bash: git push origin ca-401");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "waiting");
  await expect(nextLine(page)).toHaveText("Next: waiting on you. R1 wants to run `git push origin ca-401`.");
  await nextLine(page).getByRole("button").click();
  await expect(needsPane(page)).toBeVisible();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "permission");
  await expect(needsPane(page)).toContainText("R1 wants to run `git push origin ca-401`.");
});

test("a finished investigation wakes Pip once and starts nothing; asked again, nothing doubles", async ({ page }) => {
  await openApp(page, INSTANT_PIP);
  await startWorkstream(page, "CA-401");
  await startInvestigationAfterWake(page);
  const r1 = (await newest(page, "investigate"))!;
  await expect(wakes(page)).toHaveCount(0);

  await finishRun(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  await paneSettled(page);
  expect((await mockRuns(page)).filter((r) => r.step !== "investigate")).toEqual([]);
  expect((await actions(page, "autostart")).length).toBe(0);

  // The same finish again, and a look over everything, wake nobody.
  await advanceRuns(page, 1, r1.id);
  await surfacePullRequests(page);
  await paneSettled(page);
  await expect(wakes(page)).toHaveCount(1);
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);

  // Pip's own turns start and stop nothing.
  const before = await mockRuns(page);
  await askPip(page, "start the build");
  await paneSettled(page);
  await askPip(page, "stop R1");
  await paneSettled(page);
  expect(await mockRuns(page)).toEqual(before);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a paused workstream wakes nobody; Resume wakes Pip once for what finished meanwhile", async ({ page }) => {
  await openApp(page, INSTANT_PIP);
  await startWorkstream(page, "CA-401");
  await startInvestigationAfterWake(page);
  const r1 = (await newest(page, "investigate"))!;
  await paneSettled(page);

  await pipPane(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(pausedBanner(page)).toContainText("Paused. Pip isn't woken until you resume it.");
  await finishRun(page, r1.id);
  await advanceRuns(page, 3);
  await paneSettled(page);
  expect(await wakeTurns(page)).toBe(0);
  expect(await actions(page, "wake")).toEqual([]);
  expect((await mockRuns(page)).filter((r) => r.step !== "investigate")).toEqual([]);

  await pausedBanner(page).getByRole("button", { name: "Resume" }).click();
  await expect(pausedBanner(page)).toHaveCount(0);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);
  expect((await actions(page, "paused")).map((e) => e.actor)).toEqual(["person"]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a ticket edited in Jira is noted in the timeline once, holds nothing up, and still wakes Pip", async ({ page }) => {
  await openApp(page, INSTANT_PIP);
  await startWorkstream(page, "CA-401");
  await startInvestigationAfterWake(page);
  const r1 = (await newest(page, "investigate"))!;
  await paneSettled(page);

  await editTicket(page, "CA-401", { description: "Rounding is off by a cent in the cart total, and in the invoice." });
  await expect.poll(async () => (await actions(page, "basis_drifted")).map((e) => e.detail)).toEqual(["description"]);
  await expect(pipPane(page).locator("[data-timeline-line]").filter({ hasText: "The ticket's description changed in Jira" })).toHaveCount(1);
  await expect(pausedBanner(page)).toHaveCount(0);

  await finishRun(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  expect((await actions(page, "basis_drifted")).length).toBe(1);
});

test.describe("Undo, Reopen and the paused banner", () => {
  test("the close offer goes when the ticket gets a new workstream, and Reopen is disabled with its reason", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(agentsHome(page).locator("[data-paused-banner]")).toContainText("Pip isn't woken until you resume it.");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(page.locator("[data-toast]").filter({ hasText: "Closed the workstream on CA-401" })).toBeVisible();
    await allProjects(page);
    await startWorkstream(page, "CA-401");
    await expect(page.locator("[data-toast]").filter({ hasText: "Closed the workstream on CA-401" })).toHaveCount(0);
    await openAgents(page);
    const showClosed = agentsHome(page).locator("[data-show-closed]");
    await expect(workstreamOpen(page, "CA-401")).toBeVisible();
    await showClosed.click();
    await expect(showClosed).toHaveAttribute("aria-pressed", "true");
    await expect(agentsHome(page).locator("[data-closed-workstreams]")).toBeVisible();
    const reopen = agentsHome(page).locator("[data-reopen-workstream]").first();
    await expect(reopen).toHaveAttribute("aria-disabled", "true");
    await expect(agentsHome(page).locator("[data-reopen-blocked]").first()).toHaveText("CA-401 already has an open workstream");
  });
});

test.describe("focus after Bring them here, Undo and Reopen", () => {
  test("never falls to the page, and the Under General offer is an F6 stop", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await allProjects(page);
    await startWorkstream(page, "WEB-108");
    await openAgents(page);
    await selectWorkstream(page, "WEB-108");
    const offer = agentsHome(page).locator("[data-adopt-notice]");
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Bring them here" }).focus();
    await page.keyboard.press("F6");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-adopt-notice]"))).toBe(false);
    await offer.getByRole("button", { name: "Bring them here" }).focus();
    await page.keyboard.press("Enter");
    await expectToast(page, "Brought 1 run on WEB-108 into the workstream.");
    await expect(offer).toHaveCount(0);
    await expect.poll(() => activeIsBody(page)).toBe(false);
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).focus();
    await page.keyboard.press("Enter");
    await expect(offer.getByRole("button", { name: "Bring them here" })).toBeFocused();
  });
});

test.describe("workstream start", () => {
  test("a new workstream opens with one sentence", async ({ page }) => {
    await openApp(page);
    await startWorkstream(page, "CA-401");
    const pane = pipPane(page);

    // One short sentence on what the workstream is for.
    const intro = pane.locator("[data-empty-workstream]");
    await expect(intro).toHaveText(/^Everything for CA-401 .+ stays here: its agents, drafts and our conversation\.$/);
    const text = (await intro.textContent()) ?? "";
    expect(text.length).toBeLessThanOrEqual(140);
    expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
    await expect(pane.getByText("/stop R1")).toHaveCount(0);
  });

  test("Pip home's Steps rail marks Investigate as next and keeps the later steps to one quiet line each", async ({ page }) => {
    await openApp(page);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);

    // The same intro as in the pane.
    const region = homeConversationRegion(page);
    await expect(region.locator("[data-empty-workstream]")).toHaveText(/^Everything for CA-401 /);

    const rail = stepRail(page);
    const next = rail.locator('[data-step-next="investigate"]');
    await expect(next).toBeVisible();
    await expect(next).toContainText("Not started");
    await expect(rail.locator("[data-step-next]")).toHaveCount(1);
    const quiet = rail.locator("[data-step-quiet]");
    await expect(quiet).toHaveCount(5);
    expect(await quiet.evaluateAll((els) => els.map((el) => el.getAttribute("data-step-chip")))).toEqual(["triage", "plan", "build", "review", "verify"]);
    for (const box of await quiet.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeLessThan(30);
    // Nothing visible says it; the state is there for a screen reader only.
    await expect(quiet.locator("span:not(.sr-only)").getByText("Not started")).toHaveCount(0);
    await expect(quiet.locator(".sr-only")).toHaveText(Array(5).fill("Not started"));

    // A quiet step still opens.
    const plan = rail.locator('[data-step-chip="plan"]');
    await plan.click();
    await expect(plan).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator('[data-step="plan"]')).toContainText("Nothing here yet.");
  });
});

test("Ask Pip in the peek opens its own conversation in Pip", async ({ page }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await expect(pipConversation(page)).toHaveText("Workstream: CA-401 Welcome flow refresh");
  const peek = peekSheet(page);
  await expect(peek.locator("[data-workstream] [data-status]").first()).toHaveText("Needs you");
  await expect(peek.locator("#peek-agents").getByText("Workstream: CA-401 Welcome flow refresh")).toBeVisible();
  await expect(peek.locator("#peek-agents [data-header-status] [data-status]")).toHaveText("Needs you");
  expect((await kept(page)).workstreams?.map((w) => w.itemKey)).toEqual(["CA-401"]);

  // Another ticket has none: the pane goes back to General.
  await peekTicket(page, "CA-402");
  await expect(pipConversation(page)).toHaveText("General");
  await expect(peekSheet(page).locator("[data-ask-pip]")).toBeVisible();
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
  await expect(confirm).toContainText("Its agents and drafts are kept in General.");
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(pipConversation(page)).toHaveText("Workstream: CA-401 Welcome flow refresh");

  await peek.getByRole("button", { name: "Close…" }).click();
  await confirm.getByRole("button", { name: "Close workstream" }).click();
  await expect(pipConversation(page)).toHaveText("General");
  await expect(peek.locator("[data-ask-pip]")).toBeVisible();
  expect(await page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "{}") as { events?: { action: string }[] }).events?.map((e) => e.action), STORE)).toEqual(["opened", "closed"]);
});

test("the palette asks Pip to plan the peeked ticket, which opens its workstream", async ({ page }) => {
  await openApp(page);
  await peekTicket(page, "CA-402");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search commands and tickets").fill("plan CA-402");
  await palette.getByText("Ask Pip to plan CA-402", { exact: true }).click();
  await expect(palette).toHaveCount(0);
  // The plan shows its workstream on Agents, and Pip starts the plan agent at once, so the stage may be past Intake.
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-402 .+$/);
  await expect(page.getByRole("region", { name: /^CA-402 / })).toBeVisible();

  // On a ticket that has one, the palette offers to open it instead.
  await showWorkspace(page);
  await peekTicket(page, "CA-402");
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByLabel("Search commands and tickets").fill("workstream");
  await expect(palette.getByText("Open the workstream on CA-402", { exact: true })).toBeVisible();
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
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  if (!(await pipPane(page).isVisible())) await openPip(page);
  await expect(pipConversation(page)).toHaveText("General");
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(WORKSTREAM_QUESTION, { exact: true })).toHaveCount(0);

  await peekTicket(page, "CA-401");
  await expect(pipConversation(page)).toHaveText("Workstream: CA-401 Welcome flow refresh");
  await expect(pipPane(page).getByText(WORKSTREAM_QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(ANSWER)).toBeVisible();
  await expect(pipPane(page).getByText(GENERAL_QUESTION, { exact: true })).toHaveCount(0);
  await expect(peekSheet(page).locator("[data-workstream] [data-status]").first()).toHaveText("Needs you");
});

test("a reload or a restart leaves an open workstream as it was: nothing is paused, and it still answers the person", async ({ page, context }) => {
  await openApp(page);
  await startWorkstream(page, "CA-401");
  await page.reload();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  expect((await store(page)).workstreams?.map((w) => w.pausedReason)).toEqual([null]);

  await page.close();
  const again = await context.newPage();
  await openApp(again);
  const after = await store(again);
  expect(after.workstreams?.map((w) => w.pausedReason)).toEqual([null]);
  expect(after.events?.map((e) => [e.actor, e.action, e.detail])).toEqual([["person", "opened", null]]);

  await peekTicket(again, "CA-401");
  await peekSheet(again).getByRole("button", { name: "Open in Pip" }).click();
  await expect(pipConversation(again)).toHaveText("Workstream: CA-401 Welcome flow refresh");
  await askAndWait(again, WORKSTREAM_QUESTION);
});

test("the close confirm opens on Keep, so Enter twice never closes the workstream", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  const controls = pipPane(page).locator("[data-workstream-controls]");
  await controls.getByRole("button", { name: "Close…" }).click();
  const ask = controls.getByRole("group", { name: "Close this workstream" });
  await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  await expect(workstreamGroup(page, "CA-401")).toHaveCount(1);
});

test.describe("Close beside Pause", () => {
  test("an idle workstream's controls show Close, which asks before closing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask).toContainText("its agents and drafts are kept");
    // Keep takes it back; Close goes through.
    await ask.getByRole("button", { name: "Keep" }).click();
    await expect(ask).toHaveCount(0);
    // The keyboard goes back to Close, so Esc does as well.
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamGroup(page, "CA-401")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });
});

test.describe("Esc on the Close confirm", () => {
  test("Esc on the Close confirm keeps the keyboard on Close… with a toast up", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(toast(page)).toContainText("Paused CA-401.");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
  });
});

test.describe("the workstream controls", () => {
  test("hint at Pause, Close and the menu, and say the notes are empty", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE_TICKET);
    await openAgents(page);
    await selectWorkstream(page, VAGUE_TICKET);
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Pause" })).toHaveAccessibleDescription("Pip isn't woken; its agents carry on");
    await expect(controls.getByRole("button", { name: "Close…" })).toHaveAccessibleDescription("Its conversation goes back to General; its agents and drafts are kept in General");
    await expect(controls.getByRole("button", { name: "More for this workstream" })).toHaveAccessibleDescription("More: stop the workstream");
    await expect(agentsHome(page).getByRole("region", { name: "Pip's notes" })).toContainText("No notes yet.");
  });
});

test.describe("a workstream opened on a ticket with runs in General", () => {
  test("offers them in one line, moves them only on the button, audits it, and Undo puts them back", async ({ page }) => {
    test.setTimeout(120_000);
    // The sample's running investigation of WEB-108 was started from the board, so it sits under General.
    await openApp(page);
    await allProjects(page);
    await startWorkstream(page, "WEB-108");
    await openAgents(page);
    await selectWorkstream(page, "WEB-108");
    await homeSettled(page);
    const offer = agentsHome(page).locator("[data-adopt-notice]");
    await expect(offer).toContainText("1 run on WEB-108 is under General.");
    const runs = homeConversationRegion(page).locator('[data-timeline-entry^="run:"]');
    // Opening moved nothing: the workstream's timeline has no run, and the audit has no adoption.
    await expect(runs).toHaveCount(0);
    expect((await workstreamEvents(page)).some((e) => e.action === "adopted")).toBe(false);

    await offer.getByRole("button", { name: "Bring them here" }).click();
    await expectToast(page, "Brought 1 run on WEB-108 into the workstream.");
    await expect(offer).toHaveCount(0);
    await expect(runs).toHaveCount(1);
    expect((await workstreamEvents(page)).filter((e) => e.action === "adopted")).toMatchObject([{ actor: "person", detail: "1 run" }]);

    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(offer).toContainText("1 run on WEB-108 is under General.");
    await expect(runs).toHaveCount(0);
    expect((await workstreamEvents(page)).filter((e) => e.action === "undone").map((e) => e.detail)).toEqual(["adopted"]);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("Close and Pause", () => {
  test("the Close confirm says what happens to agents, and Pause, Close… and ⋯ have a border", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    for (const name of ["Pause", "Close…", "More for this workstream"]) await expect(controls.getByRole("button", { name, exact: true })).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await controls.getByRole("button", { name: "Close…", exact: true }).click();
    const confirm = controls.getByRole("group", { name: "Close this workstream" });
    await expect(confirm).toContainText("Agents already running carry on; one still queued does not start while it is closed.");
    // Keep has the keyboard and is described by the question, so it is read with it.
    const keep = confirm.getByRole("button", { name: "Keep" });
    await expect(keep).toBeFocused();
    await expect(keep).toHaveAccessibleDescription(/Close it\? Its conversation goes back to General/);
  });
});
