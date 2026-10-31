import { invoke } from "@tauri-apps/api/core";
import type { ProbeSnapshot } from "../types";

export interface Site {
  cloudId: string;
  name: string;
  url: string;
}

export interface Account {
  accountId: string;
  name: string;
  avatarUrl: string | null;
}

export interface AuthStatus {
  site: Site | null;
  me: Account | null;
  email: string | null;
  /** `YYYY-MM-DD`, as the person said when they pasted the token. */
  expiresOn: string | null;
}

/** What the Connect Jira sheet sends. */
export interface TokenSignIn {
  site: string;
  /** Only when the site wouldn't give it. */
  cloudId?: string;
  email: string;
  token: string;
  expiresOn: string;
}

export const auth = {
  status: () => invoke<AuthStatus>("auth_status"),
  cloudId: (site: string) => invoke<string | null>("jira_cloud_id", { site }),
  connect: (input: TokenSignIn) => invoke<AuthStatus>("jira_connect", { input }),
  signOut: () => invoke<void>("sign_out"),
};

/** What the first-run screen asks of `gh`, before any connection exists. */
export const firstRun = {
  github: () => invoke<ProbeSnapshot>("first_run_github"),
  openTerminal: () => invoke<void>("first_run_open_terminal"),
};
