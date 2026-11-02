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

/** The login a ready provider's message names: "alf@acme.com", "ChatGPT". */
export const accountOf = (c: Pick<ConnectionInfo, "status">) => (c.status?.state === "ready" ? c.status.message.replace(/^Authenticated · /, "") : null);

/** "Your shell sets A and B. Claude personal doesn't use them." */
export function ignoredLine(c: Pick<ConnectionInfo, "displayName" | "status">): string | null {
  const names = c.status?.ignored ?? [];
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Your shell sets ${list}. ${c.displayName} doesn't use ${names.length === 1 ? "it" : "them"}.`;
}

/** What a provider's detail says it is used for. */
export function usedForLine(c: Pick<ConnectionInfo, "driver" | "displayName">): string {
  return c.driver === "codex" ? `New agents run on ${c.displayName} when you pick it.` : `Pip and new agents run on ${c.displayName} when you pick it. Agents already running keep going if you turn it off.`;
}
