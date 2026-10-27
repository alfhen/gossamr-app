import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPermission, askPip, mockRuns, needsPane, openApp, pipPane, startWorkstream } from "./support/app";

// Every workstream header says what happens next and why, in one line (src/lib/nextStep.ts). Pull requests show only when a test says, as supervisor.spec.ts has it.
const SAMPLE = "runs=empty&prSurface=manual";


/** The line under the workstream's controls in the Pip pane. */
const nextLine = (page: Page) => pipPane(page).locator("[data-next-step]");

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for an investigation of CA-401, which starts it. */
async function startInvestigation(page: Page) {
  await askPip(page, "investigate this");
  await settled(page);
}

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.step === kind) ?? null;

test("while a run works, the header says Pip is woken when it finishes", async ({ page }) => {
  await openApp(page, SAMPLE);
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
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
  await pipPane(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "paused");
  await expect(nextLine(page)).toHaveText("Next: paused. Resume to continue.");

  await pipPane(page).getByRole("button", { name: "Resume" }).click();
  await expect(nextLine(page)).toHaveAttribute("data-next-step", "idle");
});

test("waiting on the person, the header links to the top need and opens it in the Needs-you pane", async ({ page }) => {
  await openApp(page, SAMPLE);
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
