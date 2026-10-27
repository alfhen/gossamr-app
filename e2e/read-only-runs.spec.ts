import { expect, test, type Locator, type Page } from "@playwright/test";
import { advanceRuns, askPip, detailsOf, mockLaunches, mockRuns, openApp, openTechnical, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream, surfacePullRequests, type MockLaunch } from "./support/app";

// Phase 6: Investigate, Triage, Plan, Review and Verify launch with a restriction Claude Code itself enforces
// (`--permission-mode dontAsk` and allow/deny rules); a Build keeps what it had. The sample
// launcher records what it would pass for each launch, and the person sees the same rules where a run is started and in
// what a run was launched with.
const SAMPLE = "runs=empty&prSurface=manual";
const READ_ONLY = "Read-only: Claude Code refuses edits and writes";
const READ_ONLY_TESTS = "Read-only, except the repository's tests: Claude Code refuses edits and other writes";
const READ_ONLY_GUARD_START = "This run is read-only: Claude Code itself refuses file edits";

const runSheet = (page: Page) => page.getByRole("dialog", { name: "Agent run" });
const runCard = (page: Page, id: string) => pipPane(page).locator(`article[data-run-id="${id}"]`);

async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Asks Pip for `what` on CA-401, which starts it, and returns the run it made of `kind`. */
async function startStep(page: Page, what: string, kind: string) {
  await askPip(page, what);
  await settled(page);
  return (await newest(page, kind))!;
}

/** Moves run `id` on to done, waiting for Pip first so each finish gets its own wake. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** Moves queued run `id` on to launching, and returns the one launch the sample launcher recorded for it. */
async function launch(page: Page, id: string): Promise<MockLaunch> {
  await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("launching");
  const entries = (await mockLaunches(page)).filter((l) => l.runId === id);
  expect(entries).toHaveLength(1);
  return entries[0];
}

/** Opens a closed `<details>` by its summary inside `scope`. */
async function openDetails(scope: Locator, summary: string) {
  // The launch command sits inside the review's Technical details.
  if (summary === "Show the command (illustrative)" && (await scope.locator("[data-technical-details]").count())) await openTechnical(scope);
  const details = detailsOf(scope, summary);
  await details.locator("> summary").first().click();
  await expect(details).toHaveAttribute("open", "");
  return details;
}

/** The deny rules a read-only launch carries, said once for every check. */
function restricted(entry: MockLaunch, kind: string) {
  expect(entry.kind).toBe(kind);
  expect(entry.readOnly?.mode).toBe("dontAsk");
  expect(entry.readOnly?.deny).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git push *)", "Bash(git commit *)", "Bash(rm *)"]));
  expect(entry.readOnly?.allow).toContain("Bash(git fetch origin main)");
  expect(entry.readOnly).toMatchObject({ settingSources: "", strictMcpConfig: true });
  expect(entry.readOnly?.allow.every((r) => !r.includes("*"))).toBe(true);
  // The read-only sentence reaches the launch's guard, after the base text.
  expect(entry.guard).toContain(READ_ONLY_GUARD_START);
  expect(entry.guard.indexOf(READ_ONLY_GUARD_START)).toBeGreaterThan(0);
}

/** The person approves the Gossamr Plan description draft on CA-401 from its peek, as written. */
async function approvePlan(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

/** Opens a run's sheet from its card in Pip's pane, and the brief it was launched with. */
async function brief(page: Page, id: string) {
  await runCard(page, id).getByRole("button", { name: /^Open / }).click();
  await expect(runSheet(page)).toBeVisible();
  return openDetails(runSheet(page), "What the agent was told");
}

test("an investigation Pip starts launches read-only, and the triage started after it carries the same rules", async ({ page }) => {
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  const r1 = await startStep(page, "investigate this", "investigate");

  const first = await launch(page, r1.id);
  restricted(first, "investigate");
  await expect(runCard(page, r1.id).locator("[data-read-only]")).toHaveAttribute("title", READ_ONLY);

  // The triage started next launches restricted too.
  await finish(page, r1.id);
  const triage = await startStep(page, "triage this", "triage");
  const second = await launch(page, triage.id);
  restricted(second, "triage");
  expect(second.readOnly).toEqual(first.readOnly);
  await expect(runCard(page, triage.id).locator("[data-read-only]")).toBeVisible();

  // What it was launched with is in its brief.
  const sent = await brief(page, triage.id);
  await expect(sent.locator("[data-read-only-rules]")).toContainText("Bash(git push *)");
  await expect(sent).toContainText("--permission-mode dontAsk");
});

test("a build launches as before, and its review is restricted", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  const investigation = await startStep(page, "investigate this", "investigate");
  await finish(page, investigation.id);
  const triage = await startStep(page, "triage this", "triage");
  await finish(page, triage.id);
  const plan = await startStep(page, "plan this", "plan");
  await finish(page, plan.id);
  restricted((await mockLaunches(page)).find((l) => l.runId === plan.id)!, "plan");
  await approvePlan(page);

  const build = await startStep(page, "build it", "build");
  const built = await launch(page, build.id);
  expect(built).toMatchObject({ kind: "build", readOnly: null });
  expect(built.guard).not.toContain(READ_ONLY_GUARD_START);
  await expect(runCard(page, build.id)).toBeVisible();
  await expect(runCard(page, build.id).locator("[data-read-only]")).toHaveCount(0);
  const sent = await brief(page, build.id);
  await expect(sent.locator("[data-read-only-extras]")).toHaveCount(0);
  await expect(sent).not.toContainText("--permission-mode");
  await runSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(runSheet(page)).toHaveCount(0);

  await finish(page, build.id);
  await surfacePullRequests(page);
  const review = await startStep(page, "review it", "review");
  const reviewed = await launch(page, review.id);
  restricted(reviewed, "review");
  expect(reviewed.readOnly!.allow.some((r) => /^Bash\(git fetch origin pull\/\d+\/head\)$/.test(r))).toBe(true);
  expect(reviewed.readOnly!.allow).toContain("Bash(cargo test)");
  await expect(runCard(page, review.id).locator("[data-read-only]")).toHaveAttribute("title", READ_ONLY_TESTS);
  expect((await mockLaunches(page)).filter((l) => l.runId === build.id)).toEqual([built]);
});
