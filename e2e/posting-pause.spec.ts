import { expect, type Page, test } from "@playwright/test";
import {
  activeIsBody, commentDraft, draftOn, jiraWrites, needsPane, openAgents, openApp, pipCommentDraft, selectWorkstream,
  startWorkstream,
} from "./support/app";

test("the posting pause says each risk in a sentence of its own, quotes both, and asks no question", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\ncc @everyone\nPassword: hunter2`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  const pause = draft.locator("[data-post-pause]");
  await expect(pause).toContainText("Your edit mentions everyone at “@everyone” (line 3). It also looks like a password, key or token at “hu…” (line 4). Everyone on the ticket would see it once it is posted.");
  await expect(pause).not.toContainText("Post anyway, or keep editing?");
  await expect(pause).not.toContainText("hunter2");
  expect(await jiraWrites(page)).toEqual([]);
});

test("Esc on the posting pause is Keep editing: the pause goes, the edited text stays and the field has the keyboard", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\ncc @everyone`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.locator("[data-post-pause]")).toBeVisible();
  await draft.locator("[data-post-pause-keep]").focus();
  await page.keyboard.press("Escape");
  await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
  await expect(text).toBeFocused();
  await expect(text).toHaveValue(/cc @everyone/);
  expect(await jiraWrites(page)).toEqual([]);
});

test("Esc on Post anyway is Keep editing too, with the edited text kept and editing open", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\ncc @everyone`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.locator("[data-post-pause]")).toBeVisible();
  const anyway = draft.getByRole("button", { name: "Post anyway" });
  await anyway.focus();
  await page.keyboard.press("Escape");
  await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
  await expect(text).toBeFocused();
  await expect(text).toHaveValue(/cc @everyone/);
  expect(await jiraWrites(page)).toEqual([]);
});

test("Esc in the edit field behind the posting pause closes the editor and the warning together and keeps the words", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await draft.getByRole("button", { name: "Edit" }).click();
  const field = needsPane(page).locator("textarea").first();
  await field.fill(`${await field.inputValue()}\n\ncc @everyone\nPassword: hunter2`);
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.locator("[data-post-pause]")).toBeVisible();
  // The pause moves the keyboard to Keep editing on the next frame; focusing the field before that lands is undone by it.
  await expect(draft.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await field.focus();
  await page.keyboard.press("Escape");
  await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
  await expect(draft.getByRole("button", { name: "Edit" })).toBeFocused();
  await expect(draft).toContainText("Password: hunter2");
  expect(await jiraWrites(page)).toEqual([]);
});

test("Esc at the posting pause with the keyboard on Keep editing closes the pause and keeps the text", async ({ page }) => {
  test.setTimeout(120_000);
  const draft = await commentDraft(page);
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\nPassword: hunter2`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  const pause = draft.locator("[data-post-pause]");
  await expect(pause.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pause).toHaveCount(0);
  await expect(needsPane(page)).toBeVisible();
  await expect.poll(() => activeIsBody(page)).toBe(false);
  expect(await draft.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(text).toHaveValue(/hunter2/);
  expect(await jiraWrites(page)).toEqual([]);
});

const addLine = async (page: Page, draft: ReturnType<Page["locator"]>, line: string) => {
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\n${line}`);
  await draft.getByRole("button", { name: "Done editing" }).click();
};

test("an edit that mentions everyone or holds a password waits for a second press, and is never blocked", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await addLine(page, draft, "cc @everyone\nPassword: hunter2");
  await draft.getByRole("button", { name: "Approve" }).click();
  const pause = draft.locator("[data-post-pause]");
  await expect(pause).toContainText("Your edit mentions everyone");
  await expect(pause).toContainText("looks like a password, key or token");
  expect(await jiraWrites(page)).toEqual([]);
  // The person can pass it.
  await draft.getByRole("button", { name: "Post anyway" }).click();
  await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
});

test("an edit that only mentions a person posts at once, and editing again takes the pause back", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  await addLine(page, draft, "cc @everyone");
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.locator("[data-post-pause]")).toBeVisible();
  await draft.getByRole("button", { name: "Keep editing" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill((await text.inputValue()).replace("cc @everyone", "cc @Mette Lund"));
  await draft.getByRole("button", { name: "Done editing" }).click();
  await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
});

test("the posting pause quotes a broad mention as written and masks a secret to its first two characters", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  const draft = await draftOn(page, "CA-408");
  const pause = draft.locator("[data-post-pause]");
  const base = await needsPane(page).locator("textarea").count();
  expect(base).toBe(0);
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  const original = await text.inputValue();
  await text.fill(`${original}\n\ncc @Everyone\nPassword: hunter2`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(pause).toContainText("Your edit mentions everyone");
  await expect(pause).toContainText("at “@Everyone”");
  await expect(pause).not.toContainText("hunter2");
  // Another edit takes the pause back; with only the password it quotes that, masked.
  await draft.getByRole("button", { name: "Keep editing" }).click();
  await text.fill(`${original}\n\nPassword: hunter2`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(pause).toContainText("looks like a password, key or token at “hu…”");
  await expect(pause).not.toContainText("hunter2");
  expect(await jiraWrites(page)).toEqual([]);
});

test("a comment with two secrets pauses with both buttons in the group, the note the alert, Keep editing first, and quotes each", async ({ page }) => {
  test.setTimeout(120_000);
  const draft = await commentDraft(page);
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\nPassword: hunter2\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  const pause = draft.locator("[data-post-pause]");
  await expect(pause).toHaveAttribute("role", "group");
  await expect(pause.locator("p[role=alert]")).toHaveCount(1);
  await expect(pause).toBeVisible();
  await expect(pause).toContainText("like a password, key or token at “hu…” (line 3) and “gh…” (line 4).");
  await expect(pause).not.toContainText("hunter2");
  const keep = pause.getByRole("button", { name: "Keep editing" });
  const anyway = pause.getByRole("button", { name: "Post anyway" });
  await expect(keep).toBeFocused();
  await expect(keep).toHaveClass(/ws-btn--primary/);
  await expect(anyway).not.toHaveClass(/ws-btn--primary/);
  // Keep editing comes first, and the actions row has no second Post anyway.
  expect(await pause.evaluate((el) => !!(el.querySelector("[data-post-pause-keep]")!.compareDocumentPosition(el.querySelector("[data-post-pause-anyway]")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(draft.locator("[data-draft-actions]").getByRole("button", { name: /Post/ })).toHaveCount(0);
  expect(await jiraWrites(page)).toEqual([]);
  await keep.click();
  await expect(pause).toHaveCount(0);
  await expect(text).toBeFocused();
  expect(await jiraWrites(page)).toEqual([]);
});

test("the posting pause names the line of a secret in the draft", async ({ page }) => {
  test.setTimeout(120_000);
  const draft = await commentDraft(page);
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  const before = await text.inputValue();
  await text.fill(`${before}\n\nPassword: hunter22secret`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  const lines = `${before}\n\nPassword: hunter22secret`.split("\n").length;
  await expect(draft.locator("[data-post-pause]")).toContainText(`“hu…” (line ${lines})`);
  expect(await jiraWrites(page)).toEqual([]);
  await draft.locator("[data-post-pause]").getByRole("button", { name: "Post anyway" }).click();
  await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
  expect((await jiraWrites(page))[0].text).not.toMatch(/\(line \d+\)/);
});

test("an edited draft that holds a secret keeps the text as written and says the pause is coming before Post", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-408");
  await openAgents(page);
  await selectWorkstream(page, "CA-408");
  const draft = await pipCommentDraft(page, "CA-408");
  await draft.getByRole("button", { name: "Edit" }).click();
  const text = needsPane(page).locator("textarea").first();
  await text.fill(`${await text.inputValue()}\n\nPassword: hunter22secret`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await expect(draft).toContainText("hunter22secret");
  await expect(draft.locator("[data-secret-note]")).toContainText("This holds something that looks like a secret. Gossamr will pause before posting it.");
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft.locator("[data-post-pause]")).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);
});
