import type { ProbeSnapshot, ProbeState } from "../types";
import { GH_LOGIN_COMMAND } from "../lib/githubUrl";
import type { AuthStatus } from "./auth";

/** `gh` has no expiry to warn about. */
export type GithubProbeState = Exclude<ProbeState, "expiresSoon">;

const OFF_MESSAGE = "Off. Gossamr doesn't sync it and drafts for it wait.";

/** What `src-tauri/src/probe.rs` finds for a GitHub instance in each state, so the page can be driven through all of them. */
export function githubSnapshot(state: GithubProbeState, login: string, checkedAt: string): ProbeSnapshot {
  const found = { installed: true, version: "2.97.0", state, account: null, fix: null, checkedAt };
  switch (state) {
    case "ready":
      return { ...found, account: login, message: `gh is signed in as ${login} on github.com` };
    case "notSignedIn":
      return { ...found, message: `gh has no login for ${login} on github.com.`, fix: GH_LOGIN_COMMAND };
    case "notFound":
      return { ...found, installed: false, version: null, message: "gh isn't installed.", fix: "brew install gh" };
    case "error":
      return { ...found, account: login, message: "gh didn't answer in time. If macOS is asking for Keychain access, allow it, then check again.", fix: "gh auth status" };
    case "off":
      return { ...found, message: OFF_MESSAGE };
  }
}

export const PROBE_STATES: readonly GithubProbeState[] = ["ready", "notSignedIn", "notFound", "error", "off"];

/** What `src-tauri/src/probe.rs` finds for Jira when the token is about to run out or has been turned down. */
export function jiraSnapshot(state: "expiresSoon" | "notSignedIn", checkedAt: string): ProbeSnapshot {
  const found = { installed: true, version: null, state, account: "Alf Henderson", fix: null, checkedAt };
  return state === "expiresSoon"
    ? { ...found, message: "Token expires in 9 days" }
    : { ...found, account: null, message: "Jira turned down your token. Make a new one and paste it here." };
}

/** `acme`, `acme.atlassian.net` and a pasted address all mean the host `acme.atlassian.net`, as the desktop app reads them. */
export function mockJiraHost(site: string): string {
  const typed = site.trim().toLowerCase();
  const host = (typed.split("://").pop() ?? "").split(/[/?#]/)[0];
  return host.includes(".") ? host : `${host}.atlassian.net`;
}

export const mockCloudId = (host: string) => `cloud-${host}`;

/** Who the sample Jira token signs in as: always Alf, on whichever site was given. */
export function mockJiraStatus(host: string, email: string, expiresOn: string, cloudId?: string): AuthStatus {
  return {
    site: { cloudId: cloudId ?? mockCloudId(host), name: host, url: `https://${host}` },
    me: { accountId: "mock-me", name: "Alf Henderson", avatarUrl: null },
    email,
    expiresOn,
  };
}
