import type { FirstRunApi } from "./firstRun";
import { MockBackend } from "./mock";
import { githubSnapshot, PROBE_STATES, type GithubProbeState } from "./mockProbes";
import { mockOptionsFromUrl } from "./mockWatch";

interface FirstRunHandle {
  /** Has `gh` find `state` the next time the screen asks, as if the person had run the fix. */
  setGithub(state: GithubProbeState): void;
  /** The commands Terminal was opened on. */
  terminals(): string[];
}

declare global {
  var __gossamrFirstRun: FirstRunHandle | undefined;
}

/** `?firstRun=ready`, `notSignedIn`, `notFound` or `error` in a dev browser opens the first-run screen with `gh` in that state. */
export function firstRunStateFromUrl(): GithubProbeState | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  const state = new URLSearchParams(location.search).get("firstRun");
  return PROBE_STATES.find((s) => s === state && s !== "off") ?? null;
}

/** Module state, because React may build the screen's backend twice and the page-level handle must reach the one in use. */
let state: GithubProbeState = "ready";
const terminals: string[] = [];

export function mockFirstRun(initial: GithubProbeState): FirstRunApi {
  const jira = new MockBackend(mockOptionsFromUrl());
  state = initial;
  terminals.length = 0;
  const github = async () => {
    const found = githubSnapshot(state, "ada", new Date().toISOString());
    if (state === "notSignedIn") return { ...found, message: "gh has no login on github.com." };
    return state === "error" ? { ...found, account: null } : found;
  };
  globalThis.__gossamrFirstRun = { setGithub: (next) => void (state = next), terminals: () => terminals };
  return {
    github,
    openTerminal: async () => {
      const fix = (await github()).fix;
      if (fix) terminals.push(fix);
    },
    jiraCloudId: (site) => jira.jiraCloudId(site),
    jiraConnect: (input) => jira.jiraConnect(input),
    sampleBackend: () => jira,
  };
}
