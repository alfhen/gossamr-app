import type { ConnectionInfo, WatchState, WorkContainer } from "../types";

/**
 * Work containers (projects, teams) hold tickets and are what the rail, the filters and the project switcher are made
 * of. Code containers (repositories) hold pull requests and only live in Settings → Watching.
 */
export type ContainerDomain = "work" | "code" | "model";

type Kind = ConnectionInfo["kind"] | string | undefined;

export const domainOfKind = (kind: Kind): ContainerDomain => (kind === "github" ? "code" : kind === "provider" ? "model" : "work");

/** Whether a connection is a Jira one, the sample included. Anything that is neither GitHub nor Jira (a provider) is not. */
export const isJira = (kind: Kind) => kind === "jira" || kind === "mock";

/** Provider ids are a driver name with an optional counter (`claude`, `claude_2`, `codex`) and never contain a colon. */
const PROVIDER_ID = /^(claude|codex)(_\d+)?$/;

const domainOfId = (connectionId: string): ContainerDomain => (PROVIDER_ID.test(connectionId) ? "model" : domainOfKind(connectionId.split(":")[0]));

/** Connection ids are `kind:account`, so a connection that hasn't loaded yet still classifies. */
export function domainOfConnection(connections: readonly Pick<ConnectionInfo, "id" | "kind">[], connectionId: string): ContainerDomain {
  const known = connections.find((c) => c.id === connectionId);
  return known ? domainOfKind(known.kind) : domainOfId(connectionId);
}

export const isWorkConnection = (connectionId: string) => domainOfId(connectionId) === "work";

export const workConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[]): T[] => connections.filter((c) => domainOfKind(c.kind) === "work");

export const githubConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[]): T[] => connections.filter((c) => c.kind === "github");

/** Containers that may appear as project badges, filters and switcher entries. */
export const workContainers = (containers: readonly WorkContainer[]): WorkContainer[] => containers.filter((c) => isWorkConnection(c.ref.connectionId));

export const workWatch = (watch: readonly WatchState[]): WatchState[] => watch.filter((w) => isWorkConnection(w.connectionId));

export const codeWatch = (watch: readonly WatchState[]): WatchState[] => watch.filter((w) => domainOfId(w.connectionId) === "code");
