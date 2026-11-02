import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { claudeSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo } from "../types";
import { ProviderFormView, SignInStepView, type ProviderFormProps, type SignInStepProps } from "./ProviderSheet";

const form = (over: Partial<ProviderFormProps> = {}) =>
  renderToStaticMarkup(
    <ProviderFormView driver="claude" values={{ name: "", choice: "own", folder: "" }} usualOffered={false} busy={false} error={null} onChange={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} {...over} />,
  );

const CHECKED = "2026-10-30T11:57:00Z";
const row = (state: Parameters<typeof claudeSnapshot>[0], over: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  id: "claude_2",
  instanceId: "claude_2",
  displayName: "Claude work",
  enabled: true,
  kind: "provider",
  driver: "claude",
  configDir: "~/.claude-work",
  workspace: "",
  url: "",
  account: "",
  lastSyncAt: null,
  syncing: false,
  error: null,
  transient: false,
  reauth: false,
  status: claudeSnapshot(state, CHECKED),
  rechecking: false,
  ...over,
});
const step = (r: ConnectionInfo | undefined, over: Partial<SignInStepProps> = {}) =>
  renderToStaticMarkup(<SignInStepView row={r} checking={false} copied={false} onCopy={vi.fn()} onOpenTerminal={vi.fn()} onCheck={vi.fn()} onDone={vi.fn()} {...over} />);

describe("the Add Claude form", () => {
  it("says why each Claude has its own folder and what Gossamr does with the login", () => {
    const out = form();
    expect(out).toContain("Add Claude");
    expect(out).toContain("Each Claude has its own config folder, so its login, settings and history stay apart.");
    expect(out).toContain("Gossamr creates it if it doesn&#x27;t exist.");
    expect(out).toContain("Gossamr runs each agent on the login you pick. It never switches between logins by itself.");
    expect(out).toContain('placeholder="Claude work"');
    expect(out).toContain('placeholder="~/.claude-work"');
  });

  it("offers My usual setup only when no Claude uses it", () => {
    expect(form()).not.toContain("My usual setup");
    expect(form({ usualOffered: true })).toContain("My usual setup");
    expect(form({ usualOffered: true })).toContain("Its own folder");
  });

  it("keeps Add Claude off until there is a name and a folder, and a usual setup needs no folder", () => {
    const disabled = (over: Partial<ProviderFormProps>) => /<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/.test(form(over));
    expect(disabled({})).toBe(true);
    expect(disabled({ values: { name: "Claude work", choice: "own", folder: "" } })).toBe(true);
    expect(disabled({ values: { name: "Claude work", choice: "own", folder: "~/.claude-work" } })).toBe(false);
    expect(disabled({ usualOffered: true, values: { name: "Claude", choice: "usual", folder: "" } })).toBe(false);
  });

  it("calls a Codex folder its home and the button Add Codex", () => {
    const out = form({ driver: "codex" });
    expect(out).toContain("Add Codex");
    expect(out).toContain("Codex home");
    expect(out).toContain('placeholder="~/.codex-work"');
    expect(out).toContain("Each Codex has its own home folder");
  });

  it("shows what Rust refused", () => {
    expect(form({ error: "This folder can't be used: It must be inside your home folder." })).toContain("This folder can&#x27;t be used");
  });
});

describe("the sign-in step", () => {
  it("shows the command with Copy, Open Terminal, the check and Done while the Claude is signed out", () => {
    const out = step(row("notSignedIn", { status: { ...claudeSnapshot("notSignedIn", CHECKED), fix: "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login" } }));
    expect(out).toContain("Sign in as this Claude. Run this in Terminal, then check again.");
    expect(out).toContain("CLAUDE_CONFIG_DIR=~/.claude-work claude auth login");
    for (const word of ["Copy", "Open Terminal", "I&#x27;ve run it, check again", "Done"]) expect(out).toContain(word);
  });

  it("says Authenticated with the login once the check finds it, and drops the command", () => {
    const out = step(row("ready"));
    expect(out).toContain("Authenticated · alf@acme.com");
    expect(out).not.toContain("Open Terminal");
    expect(out).not.toContain("check again");
    expect(out).toContain("Done");
  });

  it("says it is checking before the first answer and shows what a missing CLI says", () => {
    expect(step(row("ready", { status: null }))).toContain("Checking…");
    expect(step(row("notFound"))).toContain("`claude` isn&#x27;t installed.");
  });
});
