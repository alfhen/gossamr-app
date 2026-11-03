import type { ConnectionInfo } from "../types";
import type { Driver } from "../lib/models";
import { nameProblem } from "../lib/connectionName";
import { signInCommand } from "../workspace/providerLogic";
import { claudeSnapshot, type GithubProbeState } from "./mockProbes";

const HOME = "/Users/sample";
const DATA_DIR = `${HOME}/Library/Application Support/gossamr`;
const LABEL: Record<Driver, string> = { claude: "Claude", codex: "Codex" };
const USUAL_FOLDER: Record<Driver, string> = { claude: `${HOME}/.claude`, codex: `${HOME}/.codex` };
/** The login variable the sample shell exports for each driver, which an instance with its own folder ignores. */
const SHELL_KEY: Record<Driver, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" };
const NOT_A_PROVIDER = "This isn't a provider. Reopen Settings.";

export interface MockProvider {
  id: string;
  driver: Driver;
  displayName: string;
  enabled: boolean;
  configDir?: string;
  /** `null` until the first check answers, as the desktop backend's row is when it is added. */
  probe: GithubProbeState | null;
  checkedAt: string;
  /** Terminal was opened on its sign-in, so the next check finds the login. */
  signInOpened?: boolean;
}

/** `~` and `~/…` start at the home folder; `.` and `..` are folded away. */
function normalize(typed: string): string | null {
  const full = typed === "~" ? HOME : typed.startsWith("~/") ? `${HOME}/${typed.slice(2)}` : typed;
  if (!full.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The rules of the desktop backend that need no disk (6.2 of docs/connections-proposal.md); the mock has no links to follow. */
function folderProblem(driver: Driver, typed: string, others: MockProvider[]): string | null {
  if (!typed.trim()) return "The folder is empty.";
  // eslint-disable-next-line no-control-regex
  if (/['\u0000-\u001f\u007f-\u009f]/.test(typed)) return "It has a quote or an unusual character in it.";
  const path = normalize(typed.trim());
  if (!path) return "It must be a full path, or start with ~.";
  const lower = path.toLowerCase();
  if (!lower.startsWith(`${HOME.toLowerCase()}/`)) return "It must be inside your home folder, and not the home folder itself.";
  if (lower === DATA_DIR.toLowerCase() || lower.startsWith(`${DATA_DIR.toLowerCase()}/`)) return "It is inside Gossamr's own data folder.";
  const owner = (Object.keys(USUAL_FOLDER) as Driver[]).find((d) => USUAL_FOLDER[d].toLowerCase() === lower);
  if (owner === driver) return "That's your usual setup. Choose My usual setup instead.";
  if (owner) return `That's the usual folder of ${LABEL[owner]}. Choose another folder.`;
  const taken = others.find((o) => o.configDir && normalize(o.configDir)?.toLowerCase() === lower);
  return taken ? `Another ${LABEL[taken.driver]} already uses this folder.` : null;
}

function snapshot(p: MockProvider) {
  if (p.enabled && p.probe === null) return null;
  const state = p.enabled ? p.probe! : "off";
  const found = claudeSnapshot(state, p.checkedAt);
  const own = <T extends object>(snap: T) => (p.configDir && state !== "off" ? { ...snap, ignored: [SHELL_KEY[p.driver]] } : snap);
  if (p.driver === "claude") {
    const kept = state === "off" && p.probe === "ready" ? { ...found, account: claudeSnapshot("ready", p.checkedAt).account } : found;
    return state === "notSignedIn" ? { ...own(kept), fix: signInCommand("claude", p.configDir) } : own(kept);
  }
  switch (state) {
    case "ready":
      return own({ ...found, account: null, message: "Authenticated · ChatGPT" });
    case "notSignedIn":
      return own({ ...found, message: "Not signed in to Codex.", fix: signInCommand("codex", p.configDir) });
    case "notFound":
      return own({ ...found, message: "`codex` isn't installed." });
    case "error":
      return own({ ...found, message: "Codex didn't answer in time. Check again." });
    case "off":
      return found;
  }
}

/** The mock's provider instances: the default Claude, and any added with the desktop backend's folder rules. */
export class MockProviders {
  private readonly removedDrivers = new Map<string, Driver>();
  private items: MockProvider[] = [{ id: "claude", driver: "claude", displayName: "Claude", enabled: true, probe: "ready", checkedAt: new Date().toISOString() }];
  private retired: string[] = [];

  setDefaultProbe(probe: GithubProbeState) {
    if (this.items[0]) this.items[0].probe = probe;
  }

  /** The name of `id` when it is on and its last check found it signed out, which holds a queued run back. */
  signedOutName(id: string): string | null {
    const found = this.items.find((p) => p.id === id);
    return found?.enabled && found.probe === "notSignedIn" ? found.displayName : null;
  }

  driverOf(id: string): Driver | null {
    return this.items.find((p) => p.id === id)?.driver ?? null;
  }

  /** The driver of `id` even after it was removed, which a run on it still needs to be opened. */
  keptDriverOf(id: string): Driver | null {
    return this.driverOf(id) ?? this.removedDrivers.get(id) ?? null;
  }

  /** A check of everything: an instance whose sign-in was opened in Terminal now finds its login. */
  touch(): boolean {
    const now = new Date().toISOString();
    let changed = false;
    for (const p of this.items) {
      p.checkedAt = now;
      if (p.signInOpened && p.probe === "notSignedIn") (p.probe = "ready"), (changed = true);
    }
    return changed;
  }

  /** The first check of each added instance answers: signed out, the state a fresh folder is in. */
  settle(): boolean {
    let changed = false;
    for (const p of this.items) {
      if (p.probe) continue;
      p.probe = "notSignedIn";
      changed = true;
    }
    return changed;
  }

  has(id: string): boolean {
    return this.items.some((p) => p.id === id);
  }

  add(driver: Driver, displayName: string, configDir?: string | null): MockProvider {
    const problem = nameProblem(displayName);
    if (problem) throw new Error(problem);
    const typed = configDir?.trim();
    if (typed !== undefined) {
      const refused = folderProblem(driver, typed, this.items);
      if (refused) throw new Error(`This folder can't be used: ${refused}`);
    } else {
      const usual = this.items.find((p) => p.driver === driver && !p.configDir);
      if (usual) throw new Error(`Your usual setup is already added as ${usual.displayName}.`);
    }
    const added: MockProvider = { id: this.nextId(driver), driver, displayName: displayName.trim(), enabled: true, configDir: typed, probe: null, checkedAt: new Date().toISOString() };
    this.items.push(added);
    return added;
  }

  setEnabled(id: string, enabled: boolean) {
    const target = this.items.find((p) => p.id === id);
    if (!target) throw new Error(NOT_A_PROVIDER);
    target.enabled = enabled;
    target.checkedAt = new Date().toISOString();
  }

  remove(id: string) {
    const gone = this.items.find((p) => p.id === id);
    if (gone) this.removedDrivers.set(id, gone.driver);
    this.items = this.items.filter((p) => p.id !== id);
    this.retired.push(id);
  }

  /** The command Terminal opens for `id`: its sign-in, and only while the last check found it signed out. */
  signIn(id: string): string {
    const target = this.items.find((p) => p.id === id);
    if (!target) throw new Error(NOT_A_PROVIDER);
    if (!target.enabled) throw new Error(`${target.displayName} is turned off. Turn it on first.`);
    if (target.probe !== "notSignedIn") throw new Error("Gossamr opens Terminal to sign in only when the last check found you signed out. Check it again.");
    target.signInOpened = true;
    return signInCommand(target.driver, target.configDir);
  }

  /** The folder Finder shows for `id`. */
  folderToShow(id: string): string {
    const target = this.items.find((p) => p.id === id);
    if (!target) throw new Error(NOT_A_PROVIDER);
    if (!target.configDir) throw new Error("This one uses your usual setup, which has no folder of its own to show.");
    return target.configDir;
  }

  rows(): ConnectionInfo[] {
    return this.items.map((p) => ({
      id: p.id,
      instanceId: p.id,
      displayName: p.displayName,
      enabled: p.enabled,
      kind: "provider",
      driver: p.driver,
      ...(p.configDir ? { configDir: p.configDir } : {}),
      workspace: "",
      url: "",
      account: "",
      lastSyncAt: null,
      syncing: false,
      error: null,
      transient: false,
      reauth: false,
      status: snapshot(p),
      rechecking: false,
    }));
  }

  private nextId(driver: Driver): string {
    const taken = [...this.items.map((p) => p.id), ...this.retired];
    const used = taken.flatMap((id) => (id === driver ? [1] : id.startsWith(`${driver}_`) ? [Number(id.slice(driver.length + 1))] : [])).filter(Number.isInteger);
    return used.length ? `${driver}_${Math.max(...used) + 1}` : driver;
  }
}
