import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  commentOnTicket,
  expandAllNeeds,
  githubWrites,
  homeComposer,
  homeSettled,
  jiraWrites,
  mockRuns,
  needOfKind,
  needRow,
  needsPane,
  openApp,
  openPipHome,
  paneSettled,
  peekSheet,
  pipHome,
  pipPane,
  reviewedDraft,
  startWorkstream,
  workstreamRow,
  expandNeedsYou,
  expectToast,
} from "./support/app";

// Fixes from the eleventh dogfood round: the reporter's reply shown in the decision (G4), the pause before a GitHub review with
// @everyone or a secret (G1), What Jira saw from me saying GitHub reviews are not listed (G2), numbered answers paired under
// their questions (G3), and the chip "Post" on a review draft (G6).

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does. */
async function startInvestigation(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** Moves run `id` on to done once Pip has answered, so each finish gets a wake turn of its own. */
async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** A managed workstream on the vague ticket, its investigation and the triage a rule started: not ready to plan. Left on Pip home. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
  await finish(page, (await newest(page, "triage"))!.id);
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("the reporter's reply in the decision (G4)", () => {
  test("shows the quoted reply above the ticket, opens it from a link, and Plan now toasts that it plans with the reply", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await commentOnTicket(page, VAGUE, "Done means all three emails send in the sandbox. The CRM team is waiting.");
    const need = needRow(page, "the reporter replied, plan now?");
    await need.click();
    const reply = needsPane(page).locator("[data-reporter-reply]");
    await expect(reply).toContainText("The reporter replied");
    await expect(reply).toContainText("“Done means all three emails send in the sandbox.");
    await expect(reply.getByRole("button", { name: "Open their comment" })).toBeVisible();
    await expect(needsPane(page)).toContainText("Read their reply and the ticket, then plan or ask again");
    // The reply comes before the ticket's own text.
    const order = await needsPane(page).evaluate((el) => {
      const a = el.querySelector("[data-reporter-reply]");
      const b = el.querySelector("[data-ticket-now]");
      return !a || !b ? true : !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
    await needsPane(page).getByRole("button", { name: "Plan now" }).click();
    await expectToast(page, "Planning now with the reporter's reply on the ticket.");
  });
});

test.describe("numbered answers (G3)", () => {
  test("go under their questions one by one, and the card says so", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    const prefill = await homeComposer(page).inputValue();
    await homeComposer(page).fill(`${prefill}1. Done means the winback mail goes to lapsed customers. 2. The open rate should rise. 3. Only the winback flow. 4. The CRM team.`);
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expandNeedsYou(page, VAGUE);
    await needRow(page, "Answers to the open questions").click();
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft).toContainText("“What is in scope and what is out?” Answer: Only the winback flow.");
    await expect(draft).toContainText("“Who asked for this, and who is waiting on it?” Answer: The CRM team.");
    await expect(draft).not.toContainText("Answers:");
    await expect(draft.locator('[data-provenance="pip"]')).toContainText("each answer under its question");
  });

  test("a reply that doesn't pair says the questions come first and the answers as written", async ({ page }) => {
    test.setTimeout(120_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    const prefill = await homeComposer(page).inputValue();
    await homeComposer(page).fill(`${prefill}It is all about the winback flow.`);
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expandNeedsYou(page, VAGUE);
    await needRow(page, "Answers to the open questions").click();
    const draft = needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` });
    await expect(draft).toContainText("Answers: It is all about the winback flow.");
    await expect(draft.locator('[data-provenance="pip"]')).toContainText("the questions, then your answers as written");
    await expect(draft.locator('[data-provenance="pip"]')).not.toContainText("each answer under its question");
    await expect(pipHome(page)).not.toContainText("each under its question");
  });
});

test.describe("a GitHub review with risky words (G1)", () => {
  test("pauses on @everyone in the summary, posts nothing until Post it anyway, and Esc keeps the edit", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const summary = review.locator("[data-review-summary]");
    await summary.fill(`${await summary.inputValue()} cc @everyone`);
    await review.getByRole("button", { name: /^Post review/ }).click();
    const pause = review.locator("[data-post-pause]");
    await expect(pause).toContainText("Your edit mentions everyone at “@everyone” (line 6). Everyone on the pull request would see it once it is posted.");
    await expect(pause.getByRole("button", { name: "Keep editing" })).toBeFocused();
    expect(await githubWrites(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(pause).toHaveCount(0);
    await expect(summary).toHaveValue(/cc @everyone/);
    expect(await githubWrites(page)).toEqual([]);
    await review.getByRole("button", { name: /^Post review/ }).click();
    await expect(pause).toBeVisible();
    await review.getByRole("button", { name: "Post it anyway" }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    expect((await githubWrites(page))[0].body).toContain("cc @everyone");
  });

  test("pauses on a secret in an inline comment, masked in the note", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const comment = review.getByRole("textbox", { name: /^Comment on src\/consumer\/retry\.ts:42/ });
    await comment.fill(`${await comment.inputValue()} password: hunter22x`);
    await review.getByRole("button", { name: /^Post review/ }).click();
    const pause = review.locator("[data-post-pause]");
    await expect(pause).toContainText("like a password, key or token at “hu…”");
    await expect(pause).not.toContainText("hunter22x");
    expect(await githubWrites(page)).toEqual([]);
    await pause.getByRole("button", { name: "Keep editing" }).click();
    await expect(pause).toHaveCount(0);
    expect(await githubWrites(page)).toEqual([]);
  });

  test("does not pause a review with no risky words", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const summary = review.locator("[data-review-summary]");
    await summary.fill(`${await summary.inputValue()} Thanks, @mette.`);
    await review.getByRole("button", { name: /^Post review/ }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    await expect(peekSheet(page).locator("[data-post-pause]")).toHaveCount(0);
  });
});

test.describe("What Jira saw from me and GitHub reviews (G2)", () => {
  test.use({ storageState: DAY_DUE });

  test("says the GitHub reviews are not listed and where they show", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day] [data-day-sent]").click();
    const sent = page.locator("[data-jira-sent]");
    await expect(sent.getByRole("heading", { name: "What Jira saw from me" })).toBeVisible();
    await expect(sent).toContainText("GitHub reviews Gossamr posted are not listed here; each shows in its workstream's timeline as “You posted an agent's GitHub review”.");
    await expect(sent).toContainText("No posts to Jira from Gossamr are on record here.");
  });
});

test.describe("the chip on a GitHub review draft (G6)", () => {
  test("reads Post, not Approve, while its group stays Approve", async ({ page }) => {
    test.setTimeout(90_000);
    await reviewedDraft(page);
    await peekSheet(page).getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
    await openPipHome(page);
    await expandAllNeeds(page);
    const row = needRow(page, "GitHub review");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await expect(row.locator("[data-needs-you-chip]")).toHaveText("Post");
  });
});


// Keyboard and screen-reader fixes (G5, G7 to G14).

test.describe("Ctrl+0 inside a workstream (G7, G8)", () => {
  test("opens General from an empty composer, says it is off while a message is typed, and leaves the keyboard on General's row", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    const general = pipHome(page).locator('[data-workstream-row="general"]');
    await workstreamRow(page, "CA-401").click();
    await expect(general).toHaveAttribute("aria-selected", "false");
    // Typed words keep the key off, and it says so.
    await homeComposer(page).fill("half a thought");
    await page.keyboard.press("ControlOrMeta+0");
    await expect(page.locator("[data-toast]")).toContainText("Ctrl+0 is off while Pip's composer holds a message; clear or send it first");
    await expect(general).toHaveAttribute("aria-selected", "false");
    // Tabbing away from the message keeps it off too.
    await pipHome(page).locator("[data-workstream-controls] button").first().focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(general).toHaveAttribute("aria-selected", "false");
    // Empty (G7), it goes on to General from the composer itself.
    await homeComposer(page).fill("");
    await homeComposer(page).focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(general).toHaveAttribute("aria-selected", "true");
    // From a button of the workstream's rail (G8) the keyboard is not left on the page.
    await workstreamRow(page, "CA-401").click();
    await pipHome(page).locator("[data-workstream-controls] button").first().focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(general).toHaveAttribute("aria-selected", "true");
    await expect(general).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  });
});

test.describe("Hold and Resume keep the keyboard (G9), Close… is asked as a group (G13)", () => {
  test("Hold lands on Resume, Resume on Hold, and Tab stays between Close workstream and Keep", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Hold", exact: true }).click();
    await expect(controls.getByRole("button", { name: "Resume" })).toBeFocused();
    await controls.getByRole("button", { name: "Resume" }).click();
    await expect(controls.getByRole("button", { name: "Hold", exact: true })).toBeFocused();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await expect(ask).toHaveAttribute("aria-describedby", /\S+ \S+/);
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Close workstream" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
  });

  test("the held banner and the clarity notice are not live regions that hold buttons (G10)", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Hold", exact: true }).click();
    await expect(controls.locator("[data-held-banner]")).toHaveAttribute("role", "group");
    expect(await page.locator('[role="status"]:not([data-toast-host])').evaluateAll((els) => els.filter((el) => el.querySelector("button")).map((el) => el.outerHTML.slice(0, 160)))).toEqual([]);
  });
});

test.describe("the workstream list's names (G12)", () => {
  test("a row is named by its key, title and status, not by the status's sentence", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    const row = workstreamRow(page, "CA-401");
    await expect(row).toHaveAttribute("aria-label", /^CA-401 .+, [A-Z][\w ]+/);
    expect(((await row.getAttribute("aria-label")) ?? "").length).toBeLessThan(120);
    await expect(row).not.toHaveAttribute("aria-label", /Nothing is running|waits on you/);
    await expect(row).toHaveAttribute("aria-describedby", /\S+/);
  });
});

test.describe("Plan my week for a screen reader (G11)", () => {
  test.use({ storageState: DAY_DUE });

  test("names a row by its place and title, says where a moved pick went, and names the This week button", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    const first = plan.locator("[data-plan-pick]").first();
    await expect(first).toHaveAttribute("aria-label", /^1\. .*[A-Z]+-\d+/);
    await expect(first).not.toHaveAttribute("aria-label", /Because|Alt and/i);
    await expect(first).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    await first.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(plan.locator("[data-plan-moved]")).toHaveText(/ moved to position 2 of 3$/);
    await plan.getByRole("button", { name: "Keep this plan" }).click();
    await expect(pipHome(page).getByRole("button", { name: "Edit this week's plan" })).toBeVisible();
  });
});

test.describe("Esc at the posting pause (G14)", () => {
  test("closes the editor and the warning together and keeps the words", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    const field = needsPane(page).locator("textarea").first();
    await field.fill(`${await field.inputValue()}\n\ncc @everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await expect(draft.getByRole("button", { name: "Edit" })).toBeFocused();
    await expect(draft).toContainText("Password: hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("what limits a build on GitHub (G5)", () => {
  test("Pip's intro says it is a request, applies with Pushing ticked, and runs as the person", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await expect(pipHome(page).getByRole("region", { name: "Conversation" })).toContainText("a Build runs as you: its prompt asks it to push only its own branch to a draft pull request, always in a workstream and otherwise when Pushing is ticked. That is a request, not a lock; see Agent safety.");
  });
});
