import type { ProbeSnapshot, ProbeState } from "../types";

/** `gh` has no expiry to warn about. */
export type GithubProbeState = Exclude<ProbeState, "expiresSoon">;

const LOGIN_COMMAND = "gh auth login -h github.com";

/** What `src-tauri/src/probe.rs` finds for a GitHub instance in each state, so the page can be driven through all of them. */
export function githubSnapshot(state: GithubProbeState, login: string, checkedAt: string): ProbeSnapshot {
  const found = { installed: true, version: "2.97.0", state, account: null, fix: null, checkedAt };
  switch (state) {
    case "ready":
      return { ...found, account: login, message: `Signed in as ${login} on github.com` };
    case "notSignedIn":
      return { ...found, message: `gh has no login for ${login} on github.com.`, fix: LOGIN_COMMAND };
    case "notFound":
      return { ...found, installed: false, version: null, message: "gh isn't installed.", fix: "brew install gh" };
    case "error":
      return { ...found, account: login, message: "gh didn't answer in time. If macOS is asking for Keychain access, allow it, then check again.", fix: "gh auth status" };
    case "off":
      return { ...found, message: "Off. Gossamr doesn't sync it, Pip can't see it and drafts for it wait." };
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
