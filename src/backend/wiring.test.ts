import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEW_CHANGED, REVIEW_MAYBE_POSTED_NOTE, REVIEW_NOT_FOUND_NOTE, REVIEW_OUTDATED_NOTE } from "../lib/proposals";
import { EVENTS } from "./events";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Every source file under `dir`, tests excluded. */
function sources(dir: URL): string[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir.href.endsWith("/") ? dir : `${dir.href}/`);
    if (statSync(url).isDirectory()) return sources(url);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(url, "utf8")] : [];
  });
}

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

  it("registers no command the front end never invokes", () => {
    const front = sources(new URL("../", import.meta.url)).join("\n");
    const invoked = new Set([...front.matchAll(/invoke(?:<[^(]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
    expect([...registered()].filter((c) => !invoked.has(c))).toEqual([]);
  });

  it("sends a review draft's post, diff and access with the argument names the commands take", () => {
    const jira = read("./jira.ts");
    expect(jira).toContain('invoke<Proposal>("proposals_post_review", { id, revisions, postAnyway })');
    const lib = read("../../src-tauri/src/lib.rs");
    expect(lib).toContain("async fn proposals_post_review(app: AppHandle, core: State<'_, CoreState>, id: String, revisions: usize, post_anyway: Option<bool>)");
    expect(lib).toMatch(/async fn code_pull_diff\(core: State<'_, CoreState>, connection_id: String, repo: String, number: u64\)/);
    expect(lib).toMatch(/async fn code_review_access\(core: State<'_, CoreState>, connection_id: String, repo: String\)/);
    expect(jira).toMatch(/"code_pull_diff", \{ connectionId, repo, number \}/);
    expect(jira).toMatch(/"code_review_access", \{ connectionId, repo \}/);
  });

  it("reads a review draft's notes in the backend's words", () => {
    const rust = read("../../src-tauri/src/inbox/code.rs").replace(/"\s*\n\s*"/g, "");
    expect(rust).toContain(`pub const REVIEW_OUTDATED_NOTE: &str =\n    "${REVIEW_OUTDATED_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_MAYBE_POSTED_NOTE: &str = "${REVIEW_MAYBE_POSTED_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_NOT_FOUND_NOTE: &str =\n    "${REVIEW_NOT_FOUND_NOTE}";`);
    expect(rust).toContain(`pub const REVIEW_CHANGED: &str = "${REVIEW_CHANGED}";`);
  });
});

describe("the events between Rust and the page", () => {
  const names = Object.values(EVENTS).sort();

  it("are the four Rust can emit", () => {
    const wire = read("../../src-tauri/src/wire.rs");
    const emitted = [...wire.matchAll(/Event::\w+ => "([a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["changed", "open-run", "pip", "snapshot"]);
    expect(emitted).toEqual(names);
  });

  it("are the only ones the front end listens to", () => {
    const listened = sources(new URL("../", import.meta.url)).flatMap((text) => [...text.matchAll(/\blisten(?:<[^(]*>)?\(\s*([^,)]+)/g)].map((m) => m[1].trim()));
    expect(listened.length).toBeGreaterThan(3);
    const allowed = new Set(Object.keys(EVENTS).map((k) => `EVENTS.${k}`));
    expect(listened.filter((arg) => !allowed.has(arg))).toEqual([]);
  });

  it("name each topic Rust sends", () => {
    const wire = read("../../src-tauri/src/wire.rs");
    const topics = /pub enum Topic \{([\s\S]*?)\n\}/.exec(wire)![1]
      .split("\n")
      .filter((l) => /^\s+[A-Z]\w+,/.test(l))
      .map((l) => l.trim().replace(",", "").replace(/^[A-Z]/, (c) => c.toLowerCase()));
    const events = read("./events.ts");
    const declared = /export type Topic =([^;]*);/.exec(events)![1].match(/"(\w+)"/g)!.map((t) => t.replace(/"/g, ""));
    expect(declared.sort()).toEqual(topics.sort());
  });
});
