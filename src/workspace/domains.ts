import type { ConnectionInfo, WatchState, WorkContainer } from "../types";

/**
 * Work containers (projects, teams) hold tickets and are what the rail, the filters and the project switcher are made
 * of. Code containers (repositories) hold pull requests and only live in Settings → Watching.
 */
export type ContainerDomain = "work" | "code" | "model";

type Kind = ConnectionInfo["kind"] | string | undefined;

const PROVIDER_ID = /^(claude|codex)(_\d+)?$/;

export const domainOfKind = (kind: Kind): ContainerDomain => (kind === "github" ? "code" : kind === "provider" || PROVIDER_ID.test(kind ?? "") ? "model" : "work");

/** Whether a connection is a Jira one, the sample included. Anything that is neither GitHub nor Jira (a provider) is not. */
export const isJira = (kind: Kind) => kind === "jira" || kind === "mock";

/** Connection ids are `kind:account`, so a connection that hasn't loaded yet still classifies. */
export function domainOfConnection(connections: readonly Pick<ConnectionInfo, "id" | "kind">[], connectionId: string): ContainerDomain {
  const known = connections.find((c) => c.id === connectionId);
  return known ? domainOfKind(known.kind) : domainOfKind(connectionId.split(":")[0]);
}

export const isWorkConnection = (connectionId: string) => domainOfKind(connectionId.split(":")[0]) === "work";

export const workConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[]): T[] => connections.filter((c) => domainOfKind(c.kind) === "work");

/** The connection a bare conversation id is the primary's on, as `Core::primary` in src-tauri/src/inbox.rs picks it: the first work connection, or the first one that is on when there are several. */
export function primaryConnection(connections: readonly ConnectionInfo[]): string | undefined {
  const jira = workConnections(connections).filter((c) => isJira(c.kind));
  return (jira.length > 1 ? jira.find((c) => c.enabled) : undefined)?.id ?? jira[0]?.id;
}

/** The Jira connections that are on, in list order. */
export const jiraOn = <T extends Pick<ConnectionInfo, "kind" | "enabled">>(connections: readonly T[]): T[] => workConnections(connections).filter((c) => isJira(c.kind) && c.enabled !== false);

/** The connection picked in Pip's drawer, if it is still one of several Jira connections that are on. */
export const drawerConnectionOf = (connections: readonly ConnectionInfo[], picked: string | null): string | null => {
  const on = jiraOn(connections);
  return on.length > 1 && on.some((c) => c.id === picked) ? picked : null;
};

export const primaryConnectionInfo = <T extends ConnectionInfo>(connections: readonly T[]): T | undefined => {
  const id = primaryConnection(connections);
  return connections.find((c) => c.id === id);
};

export const githubConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[]): T[] => connections.filter((c) => c.kind === "github");

/** Containers that may appear as project badges, filters and switcher entries. */
export const workContainers = (containers: readonly WorkContainer[]): WorkContainer[] => containers.filter((c) => isWorkConnection(c.ref.connectionId));

export const workWatch = (watch: readonly WatchState[]): WatchState[] => watch.filter((w) => isWorkConnection(w.connectionId));

export const codeWatch = (watch: readonly WatchState[]): WatchState[] => watch.filter((w) => domainOfKind(w.connectionId.split(":")[0]) === "code");
