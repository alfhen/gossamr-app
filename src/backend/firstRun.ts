import type { ProbeSnapshot } from "../types";
import type { Backend } from "./types";
import { auth, firstRun, type AuthStatus, type TokenSignIn } from "./auth";

/** What the first-run screen needs: what `gh` says, Terminal on its fix, and the Connect Jira form's two calls. */
export interface FirstRunApi {
  github(): Promise<ProbeSnapshot>;
  openTerminal(): Promise<void>;
  jiraCloudId(site: string): Promise<string | null>;
  jiraConnect(input: TokenSignIn, instanceId?: string): Promise<AuthStatus>;
  /** The dev mock only: the backend that took the connection, so the workspace opens on it. */
  sampleBackend?(): Backend;
}

export const desktopFirstRun: FirstRunApi = {
  github: firstRun.github,
  openTerminal: firstRun.openTerminal,
  jiraCloudId: auth.cloudId,
  jiraConnect: auth.connect,
};
