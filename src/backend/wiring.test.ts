import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANSWERS_OPENING, NUDGE_COMMENT_LABEL, REVIEW_CHANGED, REVIEW_MAYBE_POSTED_NOTE, REVIEW_NOT_FOUND_NOTE, REVIEW_OUTDATED_NOTE } from "../lib/proposals";
import { NUDGE_AFTER_DAYS, NUDGE_GONE, nudgeComment } from "../lib/reporterWait";
import { CLARITY_NOTES } from "./mockWorkstreams";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The commands `lib.rs` registers with Tauri, by name. */
function registered(): Set<string> {
  const lib = read("../../src-tauri/src/lib.rs");
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(lib)?.[1] ?? "";
  return new Set(list.split(",").map((c) => c.trim().split("::").pop()!).filter(Boolean));
}

describe("the desktop backend's wiring", () => {
  it("invokes only commands lib.rs registers", () => {
    const commands = registered();
    expect(commands.size).toBeGreaterThan(50);
    const invoked = [...read("./jira.ts").matchAll(/invoke(?:<[^(]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(invoked).toContain("proposals_post_review");
    expect(invoked.filter((c) => !commands.has(c))).toEqual([]);
  });

  it("sends a review draft's post, files, diff and access with the argument names the commands take", () => {
    const jira = read("./jira.ts");
    expect(jira).toContain('invoke<Proposal>("proposals_post_review", { id, revisions, postAnyway })');
    const lib = read("../../src-tauri/src/lib.rs");
    expect(lib).toContain("async fn proposals_post_review(app: AppHandle, core: State<'_, CoreState>, id: String, revisions: usize, post_anyway: Option<bool>)");
    for (const command of ["code_pull_files", "code_pull_diff"]) expect(lib).toMatch(new RegExp(`async fn ${command}\\(core: State<'_, CoreState>, connection_id: String, repo: String, number: u64\\)`));
    expect(lib).toMatch(/async fn code_review_access\(core: State<'_, CoreState>, connection_id: String, repo: String\)/);
    for (const command of ["code_pull_files", "code_pull_diff"]) expect(jira).toMatch(new RegExp(`"${command}", \\{ connectionId, repo, number \\}`));
    expect(jira).toMatch(/"code_review_access", \{ connectionId, repo \}/);
  });

  it("reads a review draft's notes in the backend's words", () => {
    const rust = read("../../src-tauri/src/inbox/review_drafts.rs").replace(/"\s*\n\s*"/g, "");
    expect(rust).toContain(`pub const REVIEW_OUTDATED_NOTE: &str =\n    "${REVIEW_OUTDATED_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_MAYBE_POSTED_NOTE: &str = "${REVIEW_MAYBE_POSTED_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_NOT_FOUND_NOTE: &str =\n    "${REVIEW_NOT_FOUND_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_CHANGED: &str = "${REVIEW_CHANGED}";`);
  });

  it("says the reporter nudge and the clarity notes the way the backend does", () => {
    const rust = read("../../src-tauri/src/inbox/workstreams.rs");
    expect(rust).toContain(`pub const NUDGE_GONE: &str = "${NUDGE_GONE}";`);
    expect(rust).toContain(`pub const NUDGE_AFTER_DAYS: i64 = ${NUDGE_AFTER_DAYS};`);
    expect(rust).toContain(`pub const CLARITY_NOTES: [&str; 2] = [${CLARITY_NOTES.map((n) => `"${n}"`).join(", ")}];`);
    // The comment is the same words around the greeting and the ticket's key.
    expect(rust).toContain(nudgeComment("{key}", null).replace("Hi,", "{hello}").replace("The earlier questions", "The {questions}").replace(/\n/g, "\\n"));
    expect(rust).toContain(nudgeComment("{key}", null, false, ["{q}"]).replace("Hi,", "{hello}").replace("The earlier questions", "The {questions}").replace("- {q}", "{bullets}").replace(/\n/g, "\\n"));
    expect(rust).toContain('let questions = if replied { "follow-up questions" } else { "earlier questions" };');
    expect(read("../../src-tauri/src/proposals.rs")).toContain(`pub const ANSWERS_OPENING: &str = "${ANSWERS_OPENING}";`);
    expect(read("../../src-tauri/src/proposals.rs")).toContain(`pub const NUDGE_COMMENT_LABEL: &str = "${NUDGE_COMMENT_LABEL}";`);
  });
});
