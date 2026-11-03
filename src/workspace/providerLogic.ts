import type { Backend } from "../backend/types";
import type { Driver } from "../lib/models";
import type { ConnectionInfo } from "../types";

export const DRIVER_NAME: Record<Driver, string> = { claude: "Claude", codex: "Codex" };

const FOLDER_PREFIX: Record<Driver, string> = { claude: "~/.claude-", codex: "~/.codex-" };
const SLUG_LIMIT = 40;

/** The folder a name suggests: "Claude work" gives `~/.claude-work`. Empty until the name has a letter or digit. */
export function suggestedFolder(driver: Driver, name: string): string {
  const own = name.trim().toLowerCase().replace(new RegExp(`^${driver}\\b`), "");
  const slug = own.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_LIMIT).replace(/-+$/, "");
  return slug ? `${FOLDER_PREFIX[driver]}${slug}` : "";
}

/** The usual setup can be added once per driver, so it is offered only while no instance of the driver uses it. */
export const usualSetupOffered = (connections: readonly Pick<ConnectionInfo, "kind" | "driver" | "configDir">[], driver: Driver) =>
  !connections.some((c) => c.kind === "provider" && c.driver === driver && !c.configDir);

const FOLDER_VARIABLE: Record<Driver, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const SIGN_IN: Record<Driver, string> = { claude: "claude auth login", codex: "codex login" };
const SIGN_OUT: Record<Driver, string> = { claude: "claude auth logout", codex: "codex logout" };

/** What a person types to run `command` on an instance's login: the folder variable in front, quoted as the desktop probe shows it. */
function inFolder(driver: Driver, command: string, folder?: string): string {
  if (!folder) return command;
  const plain = /^[A-Za-z0-9._~/-]*$/.test(folder);
  const value = plain ? folder : folder.startsWith("~/") ? `~/'${folder.slice(2)}'` : `'${folder}'`;
  return `${FOLDER_VARIABLE[driver]}=${value} ${command}`;
}

export const signInCommand = (driver: Driver, folder?: string) => inFolder(driver, SIGN_IN[driver], folder);
export const signOutCommand = (driver: Driver, folder?: string) => inFolder(driver, SIGN_OUT[driver], folder);

/** The login a ready provider's message names: "alf@acme.com", "ChatGPT". */
export const accountOf = (c: Pick<ConnectionInfo, "status">) => (c.status?.state === "ready" ? c.status.message.replace(/^Authenticated · /, "") : null);

/**
 * What a provider's Account line says. "Not signed in" is only for an answer that found no login; an instance that is off
 * or couldn't be checked keeps the login Rust last saw, and says nothing when it never saw one.
 */
export function accountLine(c: Pick<ConnectionInfo, "enabled" | "status">): string | null {
  const s = c.status;
  if (!s) return "Not checked yet";
  if (c.enabled && s.state === "notSignedIn") return "Not signed in";
  return accountOf(c) ?? s.account;
}

/** Whether Gossamr knows a login is in the instance's folder, so the sign-out command is worth showing. */
export const hasLogin = (c: Pick<ConnectionInfo, "enabled" | "status">) => c.status !== null && !(c.enabled && c.status.state === "notSignedIn") && (accountOf(c) ?? c.status.account) !== null;

/** "Your shell sets A and B. Claude personal doesn't use them." */
export function ignoredLine(c: Pick<ConnectionInfo, "displayName" | "status">): string | null {
  const names = c.status?.ignored ?? [];
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Your shell sets ${list}. ${c.displayName} doesn't use ${names.length === 1 ? "it" : "them"}.`;
}

/** What a provider's detail says it is used for. */
export function usedForLine(c: Pick<ConnectionInfo, "driver" | "displayName">): string {
  return c.driver === "codex" ? `${c.displayName} is in beta. Pip and agents can't run on it yet.` : `Pip and new agents run on ${c.displayName} when you pick it. Agents already running keep going if you turn it off.`;
}

/** Shows an instance's folder in Finder; a refusal or a failure goes to `report`. */
export async function revealProviderFolder(backend: Pick<Backend, "providerRevealFolder">, instanceId: string, report: (what: string, error: unknown) => void): Promise<void> {
  try {
    await backend.providerRevealFolder(instanceId);
  } catch (e) {
    report("Couldn't show the folder", e);
  }
}
