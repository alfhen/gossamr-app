import type { ProbeSnapshot, ProbeState } from "../types";

const LOGIN_COMMAND = "gh auth login -h github.com";

/** What `src-tauri/src/probe.rs` finds for a GitHub instance in each state, so the page can be driven through all of them. */
export function githubSnapshot(state: ProbeState, login: string, checkedAt: string): ProbeSnapshot {
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

export const PROBE_STATES: readonly ProbeState[] = ["ready", "notSignedIn", "notFound", "error", "off"];
