import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPermission, askPip, mockRuns, needsPane, openApp, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream } from "./support/app";

// Every workstream header says what happens next and why, in one line (src/lib/nextStep.ts). A workstream in Manage mode
// (`wsManage=1`), with pull requests shown only when a test says, as supervisor.spec.ts has it.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });

/** The line under the workstream's controls in the Pip pane. */
const nextLine = (page: Page) => pipPane(page).locator("[data-next-step]");

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for an investigation of CA-401, opens its draft past the one-time safety sheet and starts it, as the person does. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await settled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await runCards(page, "CA-401").last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Moves run `id` on to done: queued, launching, working, done. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** The person approves the Gossamr Plan description draft on CA-401 from its peek, as written. */
async function approvePlan(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

test("while a build works, the header says a review starts by itself when it finishes", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await finish(page, (await started(page, "plan")).id);
  await approvePlan(page);
  const build = await started(page, "build");
  await advanceRuns(page, 2, build.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("working");

  await expect(nextLine(page)).toHaveAttribute("data-next-step", "auto");
  await expect(nextLine(page)).toHaveText("Next: when R4 (Build) finishes, a review starts automatically.");
  await expect(nextLine(page).locator("button")).toHaveCount(0);
});

test("held, the header says so and that Resume continues; Advise says nothing starts on its own", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
  await pipPane(page).getByRole("button", { name: "Hold", exact: true }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "held");
  await expect(nextLine(page)).toHaveText("Next: held by you. Resume to continue.");

  await pipPane(page).getByRole("button", { name: "Resume" }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
  const manage = pipPane(page).getByRole("switch", { name: "Manage this workstream" });
  await manage.click();
  await expect(manage).toHaveAttribute("aria-checked", "false");
  await expect(nextLine(page)).toHaveText("Next: nothing starts on its own while Manage is off. Ask Pip to draft the next step (for example “Build this”), or start an agent from ⌘K.");
});

test("waiting on the person, the header links to the top need and opens it in the Needs-you pane", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await advanceRuns(page, 2, r1.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r1.id)?.state).toBe("working");
  await expect(nextLine(page)).toHaveText("Next: when R1 (Investigate) finishes, a triage starts automatically.");

  await askPermission(page, r1.id, "approve Bash: git push origin ca-401");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "waiting");
  await expect(nextLine(page)).toHaveText("Next: waiting on you. R1 wants to run `git push origin ca-401`.");
  await nextLine(page).getByRole("button").click();
  await expect(needsPane(page)).toBeVisible();
  await expect(needsPane(page)).toHaveAttribute("data-kind", "permission");
  await expect(needsPane(page)).toContainText("R1 wants to run `git push origin ca-401`.");
});
