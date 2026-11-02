import type { ConnectionInfo } from "../types";
import type { Driver } from "../lib/models";
import { nameProblem } from "../lib/connectionName";
import { claudeSnapshot, type GithubProbeState } from "./mockProbes";

const HOME = "/Users/sample";
const DATA_DIR = `${HOME}/Library/Application Support/gossamr`;
const LABEL: Record<Driver, string> = { claude: "Claude", codex: "Codex" };
const USUAL_FOLDER: Record<Driver, string> = { claude: `${HOME}/.claude`, codex: `${HOME}/.codex` };
const FOLDER_VARIABLE: Record<Driver, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const SIGN_IN: Record<Driver, string> = { claude: "claude auth login", codex: "codex login" };
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

/** The sign-in command a probe shows, with the folder in front when the instance has one. */
function signInCommand(driver: Driver, folder?: string): string {
  if (!folder) return SIGN_IN[driver];
  const plain = /^[A-Za-z0-9._~/-]*$/.test(folder);
  const value = plain ? folder : folder.startsWith("~/") ? `~/'${folder.slice(2)}'` : `'${folder}'`;
  return `${FOLDER_VARIABLE[driver]}=${value} ${SIGN_IN[driver]}`;
}

function snapshot(p: MockProvider) {
  if (p.enabled && p.probe === null) return null;
  const state = p.enabled ? p.probe! : "off";
  const found = claudeSnapshot(state, p.checkedAt);
  if (p.driver === "claude") return state === "notSignedIn" ? { ...found, fix: signInCommand("claude", p.configDir) } : found;
  switch (state) {
    case "ready":
      return { ...found, account: null, message: "Authenticated · ChatGPT" };
    case "notSignedIn":
      return { ...found, message: "Not signed in to Codex.", fix: signInCommand("codex", p.configDir) };
    case "notFound":
      return { ...found, message: "`codex` isn't installed." };
    case "error":
      return { ...found, message: "Codex didn't answer in time. Check again." };
    case "off":
      return found;
  }
}

/** The mock's provider instances: the default Claude, and any added with the desktop backend's folder rules. */
export class MockProviders {
  private items: MockProvider[] = [{ id: "claude", driver: "claude", displayName: "Claude", enabled: true, probe: "ready", checkedAt: new Date().toISOString() }];
  private retired: string[] = [];

  setDefaultProbe(probe: GithubProbeState) {
    if (this.items[0]) this.items[0].probe = probe;
  }

  driverOf(id: string): Driver | null {
    return this.items.find((p) => p.id === id)?.driver ?? null;
  }

  touch() {
    const now = new Date().toISOString();
    for (const p of this.items) p.checkedAt = now;
  }

  /** The first check of each added instance answers: signed out, the state a fresh folder is in. */
  settle() {
    for (const p of this.items) p.probe ??= "notSignedIn";
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
    this.items = this.items.filter((p) => p.id !== id);
    this.retired.push(id);
  }

  /** The command Terminal opens for `id`: its sign-in, and only while the last check found it signed out. */
  signIn(id: string): string {
    const target = this.items.find((p) => p.id === id);
    if (!target) throw new Error(NOT_A_PROVIDER);
    if (!target.enabled) throw new Error(`${target.displayName} is turned off. Turn it on first.`);
    if (target.probe !== "notSignedIn") throw new Error("Gossamr opens Terminal to sign in only when the last check found you signed out. Check it again.");
    return signInCommand(target.driver, target.configDir);
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
