import { expect, test, type Page } from "@playwright/test";
import { closeWorkstreamSheet, advanceRuns, agentsSettled, askPip, editTicket, expandNeedsYou, expectToast, finishOnHome, githubWrites, heldBanner, homeConversation, homeConversationRegion, homeRunCards, homeSettled, inlineStart, jiraWrites, landOnWorkspace, mockRuns, needsPane, openAgents, openApp, openPip, openTechnical, peekSheet, peekTicket, PIP_INPUT, pipConversation, pipPane, reviewedDraft, scriptNextRun, selectWorkstream, setBudget, startWorkstream, stepChip, stepRail, surfacePullRequests, wakes, workstreamEvents, workstreamGroup, openNeedRow, openRunOf, paneSettled as settled } from "./support/app";

// New workstreams open in Manage, so the sample supervisor starts the routine next steps; pull requests show only when a test says.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Moves run `id` on to done once Pip has answered, so each finish gets a wake of its own. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** Waits for a rule to have started the next run of `kind`, and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** Asks Pip in the pane for an investigation of CA-401, opens its draft past the one-time safety sheet and starts it. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await settled(page);
  const card = pipPane(page).getByRole("article", { name: "Start an agent: CA-401" }).last();
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/**
 * From a fresh managed workstream on CA-401 in the pane to a finished review of its build: the person starts the
 * investigation and approves the plan's description update, the rules start the rest. `before` runs just before the
 * review finishes.
 */
async function toFinishedReview(page: Page, before: () => Promise<void> = async () => {}) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 12 });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await finish(page, (await started(page, "plan")).id);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const plan = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await plan.getByRole("button", { name: "Update description" }).click();
  await expect(plan).toHaveCount(0);
  const build = await started(page, "build");
  await finish(page, build.id);
  await surfacePullRequests(page);
  const review = await started(page, "review");
  await before();
  await finish(page, review.id);
  await settled(page);
  return review;
}

/** The stage chip of CA-401's workstream at the head of its agents on its peek. */
async function peekStage(page: Page) {
  if (!(await peekSheet(page).isVisible())) {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
  }
  return peekSheet(page).locator("#peek-agents [data-stage]");
}

/** What Pip home says of CA-401's workstream: its row's stage and status, and the conversation's header once it is opened. */
async function homeStage(page: Page) {
  await openAgents(page);
  const row = workstreamGroup(page, "CA-401");
  await row.click();
  return { row, header: homeConversation(page) };
}

test.describe("workstream stage and holds (D3, D10, D18)", () => {
  test("a blocking review reads 'Review · changes needed' on the peek, the pane, the Pip home row and its header, never Done", async ({ page }) => {
    test.setTimeout(120_000);
    // With its fix round switched off, the blocking review is where the workstream stops.
    await toFinishedReview(page, async () => {
      await pipPane(page).getByRole("button", { name: "Automatic steps" }).click();
      await pipPane(page).getByRole("radiogroup", { name: "Blocking review → fix round" }).getByRole("radio", { name: "Off" }).click();
      await page.keyboard.press("Escape");
    });
    expect((await mockRuns(page)).filter((r) => r.kind === "build").map((r) => r.state)).toEqual(["done"]);
    await expect(await peekStage(page)).toHaveText("Review · changes needed");
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .* · Review · changes needed$/);
    const { row, header } = await homeStage(page);
    await expect(row.locator("[data-stage]")).toHaveText("Review · changes needed");
    await expect(row).not.toContainText("Done");
    await expect(header).toHaveText(/^Workstream: CA-401 .* · Review · changes needed$/);
    expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["rewrite"]);
  });

  test("a passing review reads Done", async ({ page }) => {
    test.setTimeout(120_000);
    await toFinishedReview(page, () => scriptNextRun(page, "review", { verdict: "pass" }));
    await expect(wakes(page).last()).toContainText("passed");
    await expect(await peekStage(page)).toHaveText("Done");
    const { row, header } = await homeStage(page);
    await expect(row.locator("[data-stage]")).toHaveText("Done");
    await expect(header).toHaveText(/^Workstream: CA-401 .* · Done$/);
  });

  test("a description drift in Manage says automatic steps are paused until Resume, which turns Manage back on", async ({ page }) => {
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
    await askPip(page, "investigate this");
    await homeSettled(page);
    const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
    await review.getByRole("button", { name: "Start agent" }).click();
    await expect(review).toHaveCount(0);
    await finishOnHome(page, (await newest(page, "investigate"))!.id);
    const triage = await started(page, "triage");
    expect(triage.state).toBe("queued");
    await expect(stepChip(page, "triage").locator("[data-step-auto]")).toHaveText("· started automatically");

    await editTicket(page, "CA-401", { description: "Someone rewrote the welcome flow: three emails, not two." });
    const banner = stepRail(page).locator("[data-held-banner]");
    const manage = stepRail(page).getByRole("switch", { name: "Manage this workstream" });
    await expect(banner).toContainText("Held: the ticket's description changed in Jira. Automatic steps are paused. Resume turns them back on.");
    await expect(manage).toHaveAttribute("aria-checked", "false");
    await expect(stepRail(page).locator("[data-manage-paused]")).toHaveText("paused until Resume");
    await expect(manage).toHaveAccessibleDescription(/^paused until Resume/);
    await expect(stepChip(page, "triage").locator("[data-step-auto]")).toHaveText("· waits for Resume");
    // Held, the queued triage doesn't launch.
    await advanceRuns(page, 1, triage.id);
    expect((await mockRuns(page)).find((r) => r.id === triage.id)?.state).toBe("queued");

    await banner.getByRole("button", { name: "Resume" }).click();
    await expect(banner).toHaveCount(0);
    await expect(manage).toHaveAttribute("aria-checked", "true");
    await expect(stepRail(page).locator("[data-manage-paused]")).toHaveCount(0);
    await expect(stepChip(page, "triage").locator("[data-step-auto]")).toHaveText("· started automatically");
    const resumed = (await workstreamEvents(page)).slice(-3).map((e) => [e.actor, e.action, e.detail]);
    expect(resumed).toContainEqual(["person", "mode_set", "manage"]);
    // Managed again, the triage goes on.
    await advanceRuns(page, 1, triage.id);
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === triage.id)?.state).not.toBe("queued");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("a used-up budget defines an automatic step, and Allow 5 more lifts it", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 2 });
    await startInvestigation(page);
    await finish(page, (await newest(page, "investigate"))!.id);
    await finish(page, (await started(page, "triage")).id);
    await expect(heldBanner(page)).toHaveAttribute("data-held-banner", "budget");
    await expect(heldBanner(page)).toContainText("Held: automatic steps used up");
    const help = heldBanner(page).locator("[data-step-help]");
    await help.locator("summary").click();
    await expect(help).toContainText("An automatic step is each time Pip acts without you asking, such as reading a finished run. Automatic fix rounds don't count. When they run out you can allow 5 more, or switch to Advise.");

    await heldBanner(page).getByRole("button", { name: "Allow 5 more" }).click();
    await expect(heldBanner(page)).toHaveCount(0);
    expect((await workstreamEvents(page)).filter((e) => e.action === "resumed").map((e) => [e.actor, e.detail])).toEqual([["person", "budget"]]);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

const setupSheet = setup;
const runSheet = (page: Page) => page.getByRole("dialog", { name: "Agent run" });
const sheetHint = (page: Page) => runSheet(page).locator("span.truncate").first();

/** A fresh profile on the workspace with the sample's repositories watched, so a setup sheet has a clone to start in. */
async function openWatching(page: Page) {
  await landOnWorkspace(page);
  await page.goto("/?runs=empty&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
}


test.describe("agent intro continues (D1, D25)", () => {
  test("from a ticket peek, continue opens the setup sheet with the peek still there, and Esc closes the sheet first", async ({ page }) => {
    await openApp(page, "runs=empty");
    await peekTicket(page, "CA-401");
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    await expect(safety(page)).toBeVisible();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
    await expect(safety(page).getByRole("button", { name: "Got it, continue" })).toBeFocused();
    await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    await expect(setupSheet(page)).toBeVisible();
    await expect(setupSheet(page)).toContainText("CA-401");
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
    await page.keyboard.press("Escape");
    await expect(setupSheet(page)).toHaveCount(0);
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  });

  test("Pip's intro says nothing is posted to Jira until the person approves", async ({ page }) => {
    await openApp(page);
    await openPip(page);
    await expect(pipPane(page)).toContainText("Nothing is posted to Jira until you approve it. On GitHub, a Build runs as you. In a workstream or with Pushing ticked, it is asked to push only its branch to a draft pull request: a request, not a lock; see Agent safety.");
    await expect(pipPane(page)).not.toContainText("Nothing changes until you approve");
  });
});

test.describe("sheets and launcher (D16, D24)", () => {
  test("the Pip launcher steps aside while an agent sheet is open, so Start agent is never covered", async ({ page }) => {
    await openWatching(page);
    await expect(page.locator("[data-pip-launcher]")).toBeVisible();
    await peekTicket(page, "CA-401");
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    await expect(safety(page)).toBeVisible();
    await expect(page.locator("[data-pip-launcher]")).toHaveCount(0);
    await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    await expect(setupSheet(page)).toBeVisible();
    await expect(page.locator("[data-pip-launcher]")).toHaveCount(0);
    await setupSheet(page).getByRole("combobox", { name: "Repository" }).selectOption("acme/webshop");
    const start = setupSheet(page).getByRole("button", { name: "Start agent" });
    await expect(start).toBeEnabled();
    // Nothing on top of it: a trial click hits the button itself.
    await start.click({ trial: true });
    await page.keyboard.press("Escape");
    await expect(setupSheet(page)).toHaveCount(0);
    await expect(peekSheet(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await expect(page.locator("[data-pip-launcher]")).toBeVisible();
  });

  test("stopping a run from a sheet scrolled down brings its title and the Stopped pill back into view", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Agents/ }).click();
    await page.locator('[data-run-id]').filter({ hasText: "WEB-108" }).first().click();
    await expect(runSheet(page)).toBeVisible();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "working");
    await runSheet(page).getByRole("button", { name: "Stop", exact: true }).click();
    const confirm = runSheet(page).getByRole("group", { name: "Stop this agent" });
    await expect(confirm).toBeVisible();
    // The confirm row stays on one line.
    const box = await confirm.boundingBox();
    const yes = await confirm.getByRole("button", { name: "Yes, stop" }).boundingBox();
    expect(box && yes && box.height).toBeLessThan((yes?.height ?? 0) * 1.6);
    const body = runSheet(page).locator("[data-sheet-body]");
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await confirm.getByRole("button", { name: "Yes, stop" }).dispatchEvent("click");
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(runSheet(page).getByRole("heading", { level: 2 })).toBeInViewport();
    await expect(runSheet(page).locator('span[data-state="stopped"]').first()).toBeInViewport();
  });
});

test.describe("answering and retry (D11, D14, D15)", () => {
  test("an answer from the sheet is confirmed, timed in the timeline, and the sheet keeps its place among the runs", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    // The decision's own link opens the run, with its sheet over Pip home.
    await expandNeedsYou(page);
    await openNeedRow(page, /CA-409.*asks a question/);
    await closeWorkstreamSheet(page);
    await openRunOf(page, "CA-409");
    await expect(runSheet(page)).toBeVisible();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "needsAnswer");
    const place = (await sheetHint(page).textContent())?.match(/(\d+) of (\d+)$/)?.slice(1);
    expect(place).toBeTruthy();
    await runSheet(page).getByRole("textbox", { name: "Your answer" }).fill("Yes, keep the old rounding for refunds.");
    await runSheet(page).getByRole("textbox", { name: "Your answer" }).press("ControlOrMeta+Enter");
    await expectToast(page, "Answer sent. Claude is picking it back up.");
    await expect(runSheet(page).locator("[data-answer-sent]")).toHaveText("Answer sent. Claude is picking it back up.");
    // The answer box had the keyboard; it goes to the line that replaced it, not to the page.
    await expect(runSheet(page).locator("[data-answer-sent]")).toBeFocused();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "working");
    await expect(runSheet(page).getByText("You answered")).toBeVisible();
    await expect(sheetHint(page)).toHaveText(new RegExp(` · run ${place![0]} of ${place![1]}$`));
    // What the run said while it asked is over.
    await expect(runSheet(page)).not.toContainText("Waiting for an answer");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("the answer box starts empty; Claude's suggestion is offered with Use this, and an empty box never sends", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    await expandNeedsYou(page);
    await openNeedRow(page, /CA-409.*asks a question/);
    const box = needsPane(page).getByRole("textbox", { name: "Your answer" });
    const send = needsPane(page).getByRole("button", { name: "Send answer" });
    await expect(box).toHaveValue("");
    await expect(box).toHaveAttribute("placeholder", /Write your answer/);
    await expect(send).toBeDisabled();
    await expect(needsPane(page).locator("[data-suggested-answer]")).toContainText("Claude suggests: “Yes, keep the old rounding.”");
    await needsPane(page).getByRole("button", { name: "Use this" }).click();
    await expect(box).toHaveValue("Yes, keep the old rounding.");
    await expect(send).toBeEnabled();
    await box.fill("   ");
    await expect(send).toBeDisabled();
    const details = needsPane(page).locator("details", { hasText: "What Gossamr adds" });
    await details.locator("summary").click();
    await expect(details).toContainText("This goes in front of your answer: Reminder:");
    expect((await mockRuns(page)).find((r) => r.state === "needsAnswer")).toBeTruthy();
  });

  test("copying the own-terminal command by hand, selected, enables Retry as the Copy button does", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await openAgents(page);
    // The sheet is where a failed run's command is shown to copy; the decision's link opens it.
    await expandNeedsYou(page);
    await openNeedRow(page, /SUP-9.*needs its folder trusted/);
    await closeWorkstreamSheet(page);
    await openRunOf(page, "SUP-9");
    const retry = runSheet(page).getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeDisabled();
    // Select the command's text and copy it with the keyboard; the Copy button is never pressed.
    const command = runSheet(page).getByRole("button", { name: "Copy the command" }).locator("xpath=preceding-sibling::code");
    await expect(command).toBeVisible();
    await command.selectText();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(retry).toBeEnabled();
    await expect(runSheet(page).getByRole("button", { name: "Copy the command" })).toHaveText("Copy");
  });
});

test.describe("agent counts and tray (D4, D27)", () => {
  test("Your agents says how many of all it shows, links to the rest, and lists the failed run the tray lists", async ({ page }) => {
    await openApp(page);
    await openPip(page);
    const strip = pipPane(page).getByRole("region", { name: "Your agents" });
    // Out of the runs it lists, the live ones and those waiting on the person, not the finished ones too.
    const listed = new Set(["needsAnswer", "needsPermission", "systemBlocked", "failed", "queued", "launching", "working"]);
    const total = (await mockRuns(page)).filter((r) => listed.has(r.state)).length;
    expect(total).toBeGreaterThan(3);
    expect(total).toBeLessThan((await mockRuns(page)).length);
    await expect(strip.locator("[data-strip-count]")).toHaveText(`3 of ${total}`);
    await expect(strip.locator("article[data-run-id]")).toHaveCount(3);
    await expect(strip.locator('article[data-state="failed"]')).toContainText("SUP-9");
    await strip.getByRole("button", { name: "See all in Agents" }).click();
    // The Agents view, with its layout and grouping switches.
    await expect(page.getByRole("group", { name: "Group by" })).toBeVisible();
  });

  test("the setup sheet counts agent slots in use, the runs waiting on the person among them", async ({ page }) => {
    await openWatching(page);
    await peekTicket(page, "CA-401");
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Investigate this ticket/ }).click();
    await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    await setupSheet(page).getByRole("combobox", { name: "Repository" }).selectOption("acme/webshop");
    await openTechnical(setupSheet(page));
    await expect(setupSheet(page).locator("[data-level]", { hasText: /\d+ of \d+ agent slots in use \(including ones waiting on you\)$/ })).toBeVisible();
  });

});

/** Whether the focused element sits inside `selector`. */
const focusIn = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);


test.describe("Your turn and Needs you name different things (D5)", () => {
  test("the Jira inbox is Your turn on the tab, the ticket pill, the Activity chip and the palette; Needs you is left to Pip home", async ({ page }) => {
    await openApp(page);
    // The tab, and the pill on a ticket waiting on the person's reply, which says why.
    const tab = page.getByRole("tab", { name: /^Your turn/ });
    await expect(tab).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Needs me/ })).toHaveCount(0);
    await tab.click();
    const list = page.getByRole("listbox", { name: "Items" });
    const pill = list.locator("[data-your-turn]").first();
    await expect(pill).toHaveText("Your turn");
    await expect(pill).toHaveAttribute("title", /^Your turn: an unread update, an unanswered mention, or a comment on your ticket/);
    await expect(list.getByText("Needs you", { exact: true })).toHaveCount(0);

    // The palette finds it by its new name and its old one.
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("needs me");
    await expect(dialog.getByRole("option", { name: /Filter: Your turn/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Activity's chip carries the same name and the badge's count, and lists the same needs; its feed rows carry no pill.
    await page.getByRole("button", { name: /^Activity/ }).click();
    const chips = page.getByRole("group", { name: "Show" });
    await chips.getByRole("button", { name: /^Your turn/ }).click();
    await expect(chips.getByRole("button", { name: /^Needs me/ })).toHaveCount(0);
    const badge = Number(/^Agents, (\d+) /.exec((await page.locator("[data-rail]").getByRole("button", { name: /^Agents/ }).getAttribute("aria-label")) ?? "")?.[1] ?? 0);
    await expect(page.locator("[data-needs-you-count]")).toHaveText(String(badge));
    if (badge) await expect(chips.getByRole("button", { name: /^Your turn/ })).toHaveText(new RegExp(`${badge}$`));
    await chips.getByRole("button", { name: /^All/ }).click();
    await expect(page.getByRole("feed", { name: "Activity" }).locator("[data-your-turn]")).toHaveCount(0);
  });

  test("the rail's one badge names what it counts, in its tooltip and in its button's name, and Activity has none", async ({ page }) => {
    await openApp(page);
    await agentsSettled(page, true);
    const named = async (button: RegExp, badge: RegExp) => {
      const b = page.getByRole("button", { name: button });
      await expect(b).toBeVisible();
      const tip = b.locator("[title]").filter({ hasText: /^\d+\+?$/ });
      await expect(tip).toHaveAttribute("title", badge);
      return (await tip.getAttribute("title"))!;
    };
    await named(/^Agents, \d+ things? needs? you$/, /^\d+ things? needs? you$/);
    // The bell is a link to Activity, with no number.
    const activity = page.getByRole("button", { name: "Activity", exact: true });
    await expect(activity).toBeVisible();
    await expect(activity.locator("[title]")).toHaveCount(0);
  });
});


test.describe("draft cards: click, Esc, a and s (D2, D7, D23, D28)", () => {
  /** Two comment drafts on CA-401 in the pane, with the peek closed again. */
  async function twoComments(page: Page) {
    await openApp(page);
    await peekTicket(page, "CA-401");
    await openPip(page);
    for (let i = 1; i <= 2; i++) {
      await askPip(page, "Draft a comment");
      await expect(pipPane(page).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(i);
      await settled(page);
    }
    await peekSheet(page).getByRole("button", { name: "Close details" }).click();
    await expect(peekSheet(page)).toHaveCount(0);
    return pipPane(page).getByRole("article", { name: "Comment on CA-401" });
  }

  test("one click on a draft card's 'Review on KEY →' opens the peek, and a card's key hint never changes its height", async ({ page }) => {
    const cards = await twoComments(page);
    // Arm the older card from the keyboard: ArrowUp from the empty input, then up once more.
    await page.locator(PIP_INPUT).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const armed = cards.first();
    await expect(armed).toBeFocused();
    const hint = armed.locator("[data-key-hint]");
    await expect(hint).toHaveText("a approve · e edit · d s skip · ↵ open");
    // The hint hangs under the card: the card is as tall with it as without it.
    const tall = (await armed.boundingBox())!.height;
    await page.locator(PIP_INPUT).focus();
    await expect(hint).toHaveCount(0);
    expect((await armed.boundingBox())!.height).toBe(tall);
    // From an armed card, one click on the next card's button opens the peek.
    await page.locator(PIP_INPUT).press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(armed.locator("[data-key-hint]")).toBeVisible();
    await cards.last().getByRole("button", { name: "Review on CA-401 →" }).click();
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  });

  test("an armed card's key hint hangs clear of the next card's title, in the Drafts waiting list where cards sit closest", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "investigate this");
    await homeSettled(page);
    const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
    await review.getByRole("button", { name: "Start agent" }).click();
    await expect(review).toHaveCount(0);
    await finishOnHome(page, (await newest(page, "investigate"))!.id);
    await finishOnHome(page, (await started(page, "triage")).id);
    // The wakes' drafts wait on the timeline, one under the other.
    const waiting = homeConversationRegion(page).locator('[data-timeline] article[data-draft][data-state="pending"]');
    await expect(waiting.nth(1)).toBeVisible();
    const first = waiting.first();
    await page.locator(PIP_INPUT).focus();
    // ArrowUp walks the timeline's entries, the runs and Pip's turns between the cards included.
    for (let i = 0; i < 16 && !(await first.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    const hint = first.locator("[data-key-hint]");
    await expect(hint).toBeVisible();
    const under = (await hint.boundingBox())!;
    const title = (await waiting.nth(1).locator("[data-draft-body] > div").first().boundingBox())!;
    expect(under.y + under.height).toBeLessThanOrEqual(title.y);
  });

});

test.describe("focus and keyboard (D8, D29, D30)", () => {
  test("a ticket opened from Ctrl+K takes the keyboard into its peek, and Tab stays there", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("CA-402");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-402");
    await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    await page.keyboard.press("Tab");
    expect(await focusIn(page, "#peek-sheet")).toBe(true);
    // A control of the peek's own, never the board's Filter input behind it.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
    // j and k from inside it step to the next ticket's peek, and the keyboard goes along rather than to the page.
    await peekSheet(page).locator("h2").first().focus();
    for (const step of ["j", "j", "k"]) {
      const before = await peekSheet(page).getAttribute("aria-label");
      await page.keyboard.press(step);
      await expect(peekSheet(page)).not.toHaveAttribute("aria-label", before!);
      await expect.poll(() => focusIn(page, "#peek-sheet")).toBe(true);
    }
    // Esc closes it and the keyboard goes back to the board.
    await page.keyboard.press("Escape");
    await expect(peekSheet(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

});

test.describe("starting a workstream and help (D6, D26)", () => {
  test("typing 'start a workstream' in Ctrl+K lists tickets to start it on, not only Ask Pip", async ({ page }) => {
    await openApp(page, "runs=empty");
    await agentsSettled(page, true);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("start a workstream");
    await expect(dialog.getByRole("option", { name: /^Start a workstream on [A-Z]+-\d+/ }).first()).toBeVisible();
  });

});

test.describe("plan chip (D19)", () => {
  test("'Show me the plan update' brings the plan's description draft into view and focus, and asks Pip nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 12 });
    await startInvestigation(page);
    await finish(page, (await newest(page, "investigate"))!.id);
    await finish(page, (await started(page, "triage")).id);
    await finish(page, (await started(page, "plan")).id);
    await settled(page);
    await expect(pipPane(page).getByRole("button", { name: "Approve the plan" })).toHaveCount(0);
    const chip = pipPane(page).getByRole("button", { name: "Show me the plan update" });
    await expect(chip).toBeVisible();
    const turns = await pipPane(page).locator("[data-turn-status]").count();
    await chip.click();
    // The triage's own description update stands above the plan's in the conversation: the plan's is the newer.
    const plan = pipPane(page).getByRole("article", { name: "Update the description of CA-401" }).last();
    await expect(plan).toBeFocused();
    await expect(plan).toBeInViewport();
    await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
    expect(await pipPane(page).locator("[data-turn-status]").count()).toBe(turns);
    await expect(plan).toHaveAttribute("data-state", "pending");
    // Approving the plan is signposted, in Pip's word on the finished plan and on the Plan step, with its open questions (N6).
    await expect(pipPane(page)).toContainText("Approve the description update to let Build start.");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // The plan's description update is the decision open at the top, so its note is there and not repeated on the rail.
    const note = needsPane(page).locator("[data-plan-approve]");
    await expect(note).toContainText("Approve the description update to let Build start.");
    await expect(note.locator("[data-plan-questions] li").first()).toBeVisible();
  });
});

const RETRY = "src/consumer/retry.ts";

test.describe("review card (D9, D20, D21, D32)", () => {
  test("Open PR view shows the edit still in the comment box, and posting sends it", async ({ page }) => {
    const review = await reviewedDraft(page);
    const box = review.getByRole("textbox", { name: `Comment on ${RETRY}:17` });
    const mine = "Nit: rename MAX to MAX_ATTEMPTS so it says what it limits.";
    await box.fill(mine);
    await review.getByRole("button", { name: "Open PR view" }).click();
    const view = page.getByRole("dialog", { name: "Pull request acme/webshop#218" });
    await expect(view.getByRole("note", { name: `Comment on ${RETRY}:17` })).toContainText(mine);
    // Saving the edit for the view posted nothing.
    expect(await githubWrites(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);
    await expect(box).toHaveValue(mine);

    await review.getByRole("button", { name: "Post review" }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    const [write] = await githubWrites(page);
    expect(write.event).toBe("COMMENT");
    expect(write.comments.find((c) => c.line === 17)?.body).toBe(mine);
  });

  test("says what Post sends and that comments are Markdown, grows its boxes, wraps the diff and keeps the bar off the last line", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.locator("[data-review-posts]")).toHaveText("Posts 2 inline comments and the summary as a comment review (not Approve or Request changes), at the reviewed commit. Nothing goes to GitHub until you post it here.");
    await expect(review.locator("[data-review-markdown]")).toHaveText("Markdown, formatted on GitHub");
    await review.getByRole("button", { name: `Drop comment on ${RETRY}:17` }).click();
    await expect(review.locator("[data-review-posts]")).toContainText("Posts 1 inline comment and the summary");

    // A long comment shows all its words: the box is as tall as its text.
    const box = review.getByRole("textbox", { name: `Comment on ${RETRY}:42` });
    await box.fill("The retry loop never backs off. ".repeat(12).trim());
    const fits = await box.evaluate((el: HTMLTextAreaElement) => el.scrollHeight <= el.clientHeight + 1 && el.clientHeight > 60);
    expect(fits).toBe(true);
    // Diff lines wrap inside the card rather than run off its edge.
    const hunk = review.locator("[data-review-hunk]").first();
    expect(await hunk.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await hunk.locator("[data-hunk-line] > span:last-child").first().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");

    // Scrolled to its end, the pinned bar sits under the card's last line, not over it.
    const last = review.locator("[data-review-posts]");
    await last.scrollIntoViewIfNeeded();
    await review.locator("[data-draft-actions]").scrollIntoViewIfNeeded();
    const [a, b] = [await last.boundingBox(), await review.locator("[data-draft-actions]").boundingBox()];
    expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 0.5);
  });
});

test.describe("PR view without GitHub (D17)", () => {
  test("with no GitHub connection, the Review step's PR view says so and opens the pull request on GitHub", async ({ page }) => {
    test.setTimeout(120_000);
    await toFinishedReview(page);
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[]; open: (url: string) => null };
      w.__opened = [];
      w.open = (url: string) => (w.__opened.push(String(url)), null);
    });
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const open = stepChip(page, "review").getByRole("button", { name: /^PR view of acme\/storefront#\d+$/ });
    const name = (await open.getAttribute("aria-label"))!.replace(/^PR view of /, "");
    await open.click();
    await expectToast(page, "Connect GitHub to see this pull request in Gossamr. Opened it on GitHub instead.");
    const [repo, number] = name.split("#");
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([`https://github.com/${repo}/pull/${number}`]);
    await expect(page.getByRole("dialog", { name: /^Pull request / })).toHaveCount(0);
  });
});

test.describe("Discuss with Pip on a review (D22)", () => {
  test("opens the pane with only this ticket's drafts, the rest folded, and the review talk in view", async ({ page }) => {
    const review = await reviewedDraft(page);
    await review.getByRole("button", { name: "Discuss with Pip" }).click();
    const drafts = pipPane(page).getByRole("region", { name: "Drafts" });
    await expect(pipPane(page).getByText("Discuss this review")).toBeInViewport();
    const others = drafts.locator("[data-other-tickets]");
    await expect(others).toHaveText(/^▸ \+\d+ drafts? on other tickets$/);
    await expect(others).toHaveAttribute("aria-expanded", "false");
    // Every card listed is about CA-402.
    for (const name of await drafts.getByRole("article").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.querySelector("h3")?.textContent ?? ""))) expect(name).toMatch(/CA-402|acme\/webshop#218/);
    const folded = Number((await others.textContent())!.match(/\d+/)![0]);
    const shown = await drafts.getByRole("article").count();
    await others.click();
    await expect(others).toHaveAttribute("aria-expanded", "true");
    await expect(drafts.getByRole("article")).toHaveCount(shown + folded);
    expect(await githubWrites(page)).toEqual([]);
  });
});

test.describe("description diff (D31)", () => {
  /** Plans CA-401 from its peek's Agent menu and finishes the run, which leaves a description update in the peek. */
  async function planFromPeek(page: Page) {
    const before = (await mockRuns(page)).map((r) => r.id);
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Plan this ticket/ }).click();
    await expect(setupSheet(page).or(safety(page))).toBeVisible();
    if (await safety(page).isVisible()) await safety(page).getByRole("button", { name: "Got it, continue" }).click();
    await setupSheet(page).getByRole("combobox", { name: "Repository" }).selectOption("acme/webshop");
    await setupSheet(page).getByRole("button", { name: "Start agent" }).click();
    await expect(setupSheet(page)).toHaveCount(0);
    await expect.poll(async () => (await mockRuns(page)).filter((r) => !before.includes(r.id)).length).toBe(1);
    const run = (await mockRuns(page)).find((r) => !before.includes(r.id))!;
    await advanceRuns(page, 3, run.id);
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === run.id)?.state).toBe("done");
    // Starting it opened the Agents view; the draft is on the ticket's peek.
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
    // Its short id is given at launch.
    return (await mockRuns(page)).find((r) => r.id === run.id)!;
  }

  test("a second plan that reads as the first offers no description update: the intro names no run, so nothing differs", async ({ page }) => {
    await openWatching(page);
    await peekTicket(page, "CA-401");
    const first = await planFromPeek(page);
    const update = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
    await update.getByRole("button", { name: "Update description" }).click();
    await expect(update).toHaveCount(0);

    const second = await planFromPeek(page);
    expect(first.shortId).not.toBe(second.shortId);
    // The second plan's note to the ticket is drafted, so the plan has finished and its drafts are on the peek.
    await expect(peekSheet(page).getByRole("article", { name: "Comment on CA-401" }).first()).toBeVisible();
    // The intro says who and when, not which run, and this plan reads as the first did: the description has nothing to change,
    // so no update is offered, rather than one whose only difference is a run id.
    await expect(update).toHaveCount(0);
    await expect(peekSheet(page)).not.toContainText(`agent run (${second.shortId})`);
  });
});
