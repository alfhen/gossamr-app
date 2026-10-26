import { expect, test, type Locator, type Page } from "@playwright/test";
import { pauseAtCeiling, advanceRuns, agentsHome, askPip, editTicket, expandNeedsYou, expectToast, groupByState, homeComposer, homeRunCards, homeSettled, inlineStart, jiraWrites, mockRuns, needOfKind, needRow, needsPane, needsYouCount, needsYouTray, openAgents, openApp, paneSettled as settled, pipPane, scriptNextRun, selectWorkstream, startWorkstream, stepRail, workstreamEvents, openNeedOfKind, groupOpen, needsStack } from "./support/app";

// Pip speaks up when a ticket is unclear (at intake, and as a hard stop after the triage), and a few layout and keyboard
// scenarios of Pip home (docs/needs-you.md).

const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(pipPane(page).locator("[data-pip-conversation]")).toHaveText(/^Workstream: CA-401 /);
}

/** Asks Pip for `what` on `key`, opens its draft and starts it, as the person does. */
async function startStep(page: Page, what: string, key = "CA-401") {
  await settled(page);
  await askPip(page, what);
  await settled(page);
  await runCards(page, key).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

const startInvestigation = (page: Page, key = "CA-401") => startStep(page, "investigate this", key);

const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Moves run `id` on to done once Pip has answered, so each finish gets a wake turn of its own. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

// Pip speaks up when a ticket is unclear.

const VAGUE = "CA-408";
const VAGUE_WORDS = "CA-408 may be unclear: it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it.";
/** A description that says what done looks like, what is in scope and who is waiting, which Pip's check reads as clear. */
const CLEAR_WORDS = "The retry should cap at five attempts. Only the webhook handler is in scope. The payments team is waiting on it. Done when a provider outage no longer produces a retry burst.";

/** A workstream on the sample's vague ticket, its investigation and the triage the person started after it: the triage says it is not ready to plan. Left on Pip home, on its row. */
async function unclear(page: Page) {
  await openApp(page, SAMPLE);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await startStep(page, "triage this", VAGUE);
  await finish(page, (await newest(page, "triage"))!.id);
  await openAgents(page);
  await selectWorkstream(page, VAGUE);
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("D1: Pip speaks up when a ticket is unclear", () => {
  test("its first turn in a workstream on a vague ticket says plainly what is missing, and a clear ticket gets no such line", async ({ page }) => {
    await openApp(page, SAMPLE);
    await startWorkstream(page, VAGUE);
    await settled(page);
    await askPip(page, "where do we stand?");
    await settled(page);
    await expect(pipPane(page)).toContainText(VAGUE_WORDS);
    // Only its first turn does: the second doesn't say it again. (The notice above the conversation says it once more, in its own box, the status pill's detail a third time, and the pill's hint for screen readers, which explains the phrase, a fourth. The notice's status line stays empty until its line changes, so it is not read out again on open.)
    await askPip(page, "where do we stand now?");
    await settled(page);
    expect(((await pipPane(page).innerText()).match(/may be unclear/g) ?? []).length).toBe(4);
    await expect(pipPane(page).locator("[data-clarity-notice]")).toContainText("CA-408 may be unclear");

    // A ticket whose description says what done looks like, what is in scope and who is waiting is not remarked on.
    await editTicket(page, "DEVOPS-471", { description: CLEAR_WORDS });
    await startWorkstream(page, "DEVOPS-471");
    await settled(page);
    await askPip(page, "where do we stand?");
    await settled(page);
    await expect(pipPane(page)).not.toContainText("DEVOPS-471 may be unclear");
  });

  test("a triage that says the ticket isn't ready stops the plan: a Decide need lists the questions, with the three choices", async ({ page }) => {
    await unclear(page);
    // Nothing planned, though the triage recommended a plan.
    expect(await newest(page, "plan")).toBeNull();

    const need = needRow(page, "isn't clear enough to plan");
    // Open by default, the group's row is its name and count; the need under it says what it is.
    await expect(need).toContainText("CA-408 isn't clear enough to plan");
    await expect(need).toHaveAttribute("data-group", "decide");
    await expect(needsStack(page).locator("[data-needs-you-chip]").first()).toHaveText("Decide");
    await need.click();
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "readiness");
    await expect(pane).toContainText("CA-408 isn't clear enough to plan");
    const questions = pane.locator("[data-readiness-questions] li");
    await expect(questions).toHaveCount(4);
    await expect(questions.nth(0)).toContainText("What does done look like for CA-408?");
    await expect(pane).toContainText("No plan starts until you choose.");
    for (const name of ["Ask the reporter", "I'll answer", "Plan anyway"]) await expect(pane.getByRole("button", { name })).toBeVisible();
    // The Next line says what the workstream waits on.
    await expect(agentsHome(page).locator("[data-next-step]")).toContainText("waiting on you.");
    await expect(agentsHome(page).locator("[data-next-step]")).toContainText("What does done look like for CA-408?");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("Ask the reporter drafts a comment to the reporter for approval: nothing is posted before it, and the need is answered", async ({ page }) => {
    await unclear(page);
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await expectToast(page, "Here is the comment to the reporter. Nothing is posted until you press Post comment.");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    expect(await newest(page, "plan")).toBeNull();
    const asked = (await actions(page, "readiness_asked"))[0];
    expect([asked.actor, asked.runId]).toEqual(["person", (await newest(page, "triage"))!.id]);

    // The draft is an ordinary one: Gossamr's, addressed to the reporter, listing the questions, waiting in Needs you.
    await expandNeedsYou(page, VAGUE);
    const row = needRow(page, "Questions for the reporter");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await row.click();
    await expect(needsPane(page)).toContainText("Gossamr drafted a comment to the reporter of CA-408 from R2's open questions; it is posted only when you approve it.");
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft.locator('[data-created-by="gossamr"]')).toHaveText("Drafted by Gossamr");
    await expect(draft).toContainText("@Mette Lund");
    await expect(draft).toContainText("A few things need clearing up to make this ticket clear to work on");
    await expect(draft).toContainText("What does done look like for CA-408?");
    await expect(draft).toContainText("Who asked for this, and who is waiting on it?");
    expect(await jiraWrites(page)).toEqual([]);
    // Approving it is the one thing that posts, and it goes to the ticket whole.
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", VAGUE]]);
  });

  test("I'll answer opens the workstream's conversation with the questions quoted in the composer, and starts nothing", async ({ page }) => {
    await unclear(page);
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    await expect(homeComposer(page)).toHaveValue(/^R2's open questions about CA-408: “What does done look like for CA-408\?/);
    await expect(homeComposer(page)).toHaveValue(/“What is in scope and what is out\?” · “Who asked for this, and who is waiting on it\?”\. My answers: $/);
    await expect(homeComposer(page)).toBeFocused();
    expect((await actions(page, "readiness_answered")).map((e) => e.actor)).toEqual(["person"]);
    expect(await newest(page, "plan")).toBeNull();
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("Plan anyway records the person's override, answers the need and starts nothing: Pip is asked for the plan", async ({ page }) => {
    await unclear(page);
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "Plan anyway" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    await expectToast(page, "Planning anyway. Ask Pip to draft the plan.");
    const line = (await actions(page, "readiness_overridden"))[0];
    expect([line.actor, line.runId]).toEqual(["person", (await newest(page, "triage"))!.id]);
    expect(await newest(page, "plan")).toBeNull();
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("a later triage that says ready resolves the need, and starts no plan", async ({ page }) => {
    await unclear(page);
    const first = (await newest(page, "triage"))!;
    // The person asks for another triage (Pip drafts it from the investigation); it finishes saying the ticket is ready.
    await scriptNextRun(page, "triage", { ready: true });
    await homeComposer(page).fill("triage it");
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    const review = await inlineStart(page, homeRunCards(page, VAGUE).last());
    await review.getByRole("button", { name: "Start agent" }).click();
    await expect.poll(async () => (await newest(page, "triage"))?.id).not.toBe(first.id);
    await finish(page, (await newest(page, "triage"))!.id);
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect(await newest(page, "plan")).toBeNull();
  });
});


// Layout and explanations (dogfood B1, B4, B6): Needs you is Pip home's main left column and the screen is named; a
// decision shows once, in the pane, which scrolls alone and never hides text behind its action bar; Runs across every
// workstream stays in the timeline.

const home = (page: Page) => agentsHome(page);
const boxOf = async (loc: Locator) => (await loc.boundingBox())!;

test.describe("B4: a decision shows once", () => {
  test("the pane is the only scroller in its place, and the draft's action bar is in the flow, never over the text", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual");
    await openAgents(page);
    await groupOpen(page, "General").click();
    const pane = needsPane(page);
    const bar = pane.locator("[data-draft-actions]").first();
    await expect(bar).toBeVisible();
    // Long enough to scroll, and scrolled to the middle: a sticky bar would sit over the draft's text.
    await pane.evaluate((el) => (el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)));
    const overlaps = await pane.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>("[data-draft-actions]")!;
      const before = actions.previousElementSibling as HTMLElement | null;
      return { position: getComputedStyle(actions).position, gap: before ? actions.getBoundingClientRect().top - before.getBoundingClientRect().bottom : 0 };
    });
    expect(overlaps.position).toBe("static");
    expect(overlaps.gap).toBeGreaterThanOrEqual(-1);
    // No scroller inside the pane but the pane, bar a long diff, which scrolls in a box of its own so the bar under it stays in view (round 10, G10).
    const nested = await pane.evaluate((el) => Array.from(el.querySelectorAll("*")).filter((e) => !e.matches("[data-diff]") && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length);
    expect(nested).toBe(0);
    // The last of the draft is reachable above its bar: scrolled to the end, the bar is the pane's last line.
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const [p, b] = [await boxOf(pane), await boxOf(bar)];
    expect(b.y + b.height).toBeLessThanOrEqual(p.y + p.height + 1);
  });

  test("a pause is the pane's banner alone, not the rail's as well", async ({ page }) => {
    await openApp(page, "runs=empty");
    await workstreamOnHome(page);
    // The sheet holds both: the rail's banner is the one outside the Needs you section.
    const railBanner = stepRail(page).locator("[data-paused-banner]:not([data-needs-pane] *)");
    await pauseAtCeiling(page, "CA-401");
    await expect(home(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(railBanner).toHaveCount(1);
    await openNeedOfKind(page, "paused");
    await expect(needsPane(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(home(page).locator("[data-paused-banner]")).toHaveCount(1);
    await expect(railBanner).toHaveCount(0);
    // Closed, the rail shows it again.
    await page.keyboard.press("Escape");
    await expect(railBanner).toHaveCount(1);
  });
});

// Keyboard and polish (dogfood B5, B7, B8, B11, B12): F6 reaches every region of Pip home and j/k treat every group alike;
// a command word outranks the tickets it also matches; one label for approving drafts together, whose preview opens in the
// pane; Ctrl+0 from a card's button; the launcher clear of Agents.


/** A workstream on CA-401 with two drafted comments of Pip's waiting in Needs you: one group of two needs, which may go together. */
async function twoDrafts(page: Page) {
  await openApp(page, SAMPLE);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("2");
}

test.describe("B7: a command word outranks the tickets it also matches", () => {
  const options = async (page: Page, query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type(query);
    const list = page.getByRole("dialog", { name: "Command palette" }).getByRole("option");
    await expect(list.first()).toBeVisible();
    return list;
  };

  test("fuzzy ticket search still works, and a typed ticket key still leads", async ({ page }) => {
    await openApp(page, SAMPLE);
    let list = await options(page, "retry failed payment");
    await expect(list.first()).toContainText("DEVOPS-471");
    await page.keyboard.press("Escape");
    list = await options(page, "out of memory");
    await expect(list.first()).toContainText("DEVOPS-477");
    await page.keyboard.press("Escape");
    list = await options(page, "devops-471");
    await expect(list.first()).toContainText("DEVOPS-471");
  });
});

test.describe("B8: one label for approving drafts together, and its preview opens in the decision pane", () => {
  test("'Approve N safe drafts' opens the preview and its one confirm in the pane, not inside the list; Cancel and Esc keep the drafts", async ({ page }) => {
    await twoDrafts(page);
    await expandNeedsYou(page, "CA-401");
    const batch = needsStack(page).getByRole("button", { name: "Approve 2 safe drafts" });
    await expect(batch).toHaveCount(1);
    await expect(agentsHome(page).getByRole("button", { name: /^Approve these/ })).toHaveCount(0);
    await batch.click();

    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await expect(pane.locator("[data-needs-pane-title]")).toHaveText("Approve 2 safe drafts");
    await expect(pane).toContainText("Nothing is posted until you choose.");
    await expect(pane.locator("[data-needs-you-batch-preview] li")).toHaveCount(2);
    await expect(needsYouTray(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Yes, approve 2" })).toBeFocused();
    expect(await jiraWrites(page)).toEqual([]);

    // Esc from the confirm keeps every draft, closes the pane and returns to the row.
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    await expect(needsYouCount(page)).toHaveText("2");
    await expect(needsStack(page).locator("[data-workstream-needs-title]")).toBeFocused();

    // Choosing a need's own row replaces the preview with its decision.
    await batch.click();
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await needRow(page, /Draft comment/).first().click();
    await expect(needsPane(page)).not.toHaveAttribute("data-kind", "batch");
    await expect(needsPane(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);

    // The palette's entry opens the same pane, and the confirm approves exactly the two it showed.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("approve all safe");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: /Approve all safe drafts in CA-401/ }).click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "batch");
    await needsPane(page).getByRole("button", { name: "Yes, approve 2" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsPane(page).locator("[data-batch-outcome]")).toContainText("Approved 2");
  });
});

test.describe("B11: Ctrl+0 goes to Pip home from the Agents screen with a card's button focused", () => {
  test("from a card's own button, and from the card", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();

    await page.getByRole("button", { name: /^Agents/ }).click();
    const card = page.locator("main article[data-run-id]").first();
    await card.focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(agentsHome(page)).toBeVisible();
  });

  test("plain keys on a card's button still stay with the button", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await button.focus();
    await page.keyboard.press("j");
    await expect(button).toBeFocused();
  });
});

test.describe("B12: the Pip launcher keeps clear of the Agents screen's cards and its Earlier link", () => {
  test("no card and no lane link stands under the launcher, at the top of the list or the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual");
    await page.getByRole("button", { name: /^Agents/ }).click();
    // A run the person stops goes under Earlier, folded, with its "Show" link at the lane's right end.
    await page.locator("main [data-run-id]").filter({ hasText: "WEB-108" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Agent run" });
    await sheet.getByRole("button", { name: "Stop", exact: true }).click();
    await sheet.getByRole("group", { name: "Stop this agent" }).getByRole("button", { name: "Yes, stop" }).dispatchEvent("click");
    await expect(sheet.locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    await groupByState(page);
    const show = page.locator('[data-lane="earlier"]').getByRole("button", { name: "Show" });
    await expect(show).toBeVisible();
    const scroller = page.locator("main [data-agents-list]").locator("xpath=..");
    const clear = async (what: string) => {
      const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
      const targets = [show, ...(await page.locator("main article[data-run-id]").all())];
      for (const t of targets) {
        const b = await boxOf(t);
        const over = b.x < l.x + l.width && b.x + b.width > l.x && b.y < l.y + l.height && b.y + b.height > l.y;
        expect(over, `${what}: something stands under the launcher`).toBe(false);
        // Left of its column outright, so no scroll position puts content under it.
        expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(l.x);
      }
    };
    await clear("top");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await clear("bottom");
    // The last row also ends above the launcher, with room.
    const last = await boxOf(show);
    const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
    expect(last.y + last.height).toBeLessThanOrEqual(l.y);
  });
});
