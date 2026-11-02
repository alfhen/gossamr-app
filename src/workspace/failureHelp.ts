import type { Run } from "../types";

export const INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";
export const INSTALL_URL = "https://code.claude.com/docs/en/setup";

export type FailureAct = "terminal" | "install";

export interface FailureHelp {
  kind: "untrustedFolder" | "notSignedIn" | "modeRefused" | "claudeMissing" | "noClone" | "outsideWorkFolder" | "cloneOccupied" | "capReached";
  /** One line for a card or row. */
  summary: string;
  /** The sheet's explanation. */
  detail: string;
  primary: { label: string; act: FailureAct } | null;
  /** The exact text for someone who would rather use their own terminal. */
  command: { text: string; note: string | null } | null;
  /** Retry waits for the person to have used Terminal (or copied the command) when there is something to do there first. */
  retryNeedsTerminal: boolean;
  /** Whether Retry is offered at all. A run set up outside the work folder can only be started again by Pip. */
  retry: boolean;
}

const OUTSIDE_WORK_FOLDER = {
  kind: "outsideWorkFolder",
  summary: "This agent was set up before Gossamr kept its own clones.",
  detail: "It was set up in your own clone, which Gossamr no longer starts agents in. Ask Pip to start it again, and it will use Gossamr's clone in ~/Gossamr/agents.",
  primary: null,
  command: null,
  retryNeedsTerminal: false,
  retry: false,
} as const satisfies FailureHelp;

/** `path` as one shell word, so the copied command works for a folder with spaces or quotes in its name. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

const sentence = (text: string | null | undefined, fallback: string) => (text?.trim() || fallback).replace(/\.?$/, ".");

function occupiedDetail(error: string | null | undefined): string {
  const said = sentence(error, "A folder that isn't a clone of the repository is in the way.");
  return `${said} Gossamr never removes it.${/move it away/i.test(said) ? "" : " Move it away, then retry."}`;
}

/** What to offer for a failed run that never got a session. Null for anything else. */
export function failureHelp(run: Run): FailureHelp | null {
  if (run.state !== "failed" || run.shortId) return null;
  const failure = run.failure;
  // Every start in a folder outside the work folder is refused, so no retry or step in Terminal would help.
  if (run.inWorkFolder === false) return { ...OUTSIDE_WORK_FOLDER };
  switch (failure?.type) {
    case "untrustedFolder":
      return {
        kind: "untrustedFolder",
        summary: "Claude asks you once per folder before it will work there.",
        detail: `Claude hasn't been trusted in ${failure.path} yet, so it won't start an agent there. Terminal opens in that folder with Claude: accept its trust question, then close it and retry. Claude asks because a cloned repository's own hooks, tools and settings run with the agent. Gossamr doesn't change Claude's settings for you.`,
        primary: { label: "Trust this folder in Terminal", act: "terminal" },
        command: { text: `cd ${shellQuote(failure.path)} && claude`, note: null },
        retryNeedsTerminal: true,
        retry: true,
      };
    case "notSignedIn":
      return {
        kind: "notSignedIn",
        summary: "Claude isn't signed in.",
        detail: "Terminal opens with Claude in this run's folder. Type /login, finish signing in, then close it and retry.",
        primary: { label: "Open Terminal to sign in", act: "terminal" },
        command: { text: "claude", note: "Then type /login." },
        retryNeedsTerminal: true,
        retry: true,
      };
    case "modeRefused": {
      const flag = failure.mode === "auto" ? "--permission-mode auto" : "--dangerously-skip-permissions";
      return {
        kind: "modeRefused",
        summary: `Claude hasn't accepted ${failure.mode} mode yet.`,
        detail: `${sentence(run.error, "Claude refused to run in the background in your permission mode.")} Terminal opens an interactive Claude in ${failure.mode} mode: accept its prompt, then close it and retry.`,
        primary: { label: `Open Terminal to accept ${failure.mode} mode`, act: "terminal" },
        command: { text: `claude ${flag}`, note: "Accept the prompt, then exit." },
        retryNeedsTerminal: true,
        retry: true,
      };
    }
    case "claudeMissing":
      return {
        kind: "claudeMissing",
        summary: "Claude Code isn't installed, or Gossamr can't find it.",
        detail: "Agents are Claude Code sessions, so Gossamr needs the claude command. Install it, then retry.",
        primary: { label: "Open the install page", act: "install" },
        command: { text: INSTALL_COMMAND, note: null },
        retryNeedsTerminal: false,
        retry: true,
      };
    case "noClone":
      return {
        kind: "noClone",
        summary: `Gossamr couldn't make its clone of ${run.spec.repo}.`,
        detail: `${sentence(run.error, "The clone is gone or can't be read.")} Retry makes it again.`,
        primary: null,
        command: null,
        retryNeedsTerminal: false,
        retry: true,
      };
    case "outsideWorkFolder":
      return { ...OUTSIDE_WORK_FOLDER };
    case "cloneOccupied":
      return {
        kind: "cloneOccupied",
        summary: "Something else is where Gossamr keeps its clone.",
        detail: occupiedDetail(run.error),
        primary: null,
        command: null,
        retryNeedsTerminal: false,
        retry: true,
      };
    case "capReached":
      return {
        kind: "capReached",
        summary: "Too many agents are running at once.",
        detail: `${sentence(run.error, "The limit on agents running at once is reached.")} Gossamr never starts more than that. Stop one or wait for one to finish, then retry.`,
        primary: null,
        command: null,
        retryNeedsTerminal: false,
        retry: true,
      };
    default:
      return null;
  }
}

/** Whether Retry can be pressed: always for a run that never got a session, once the step in Terminal was taken where there is one. */
export function retryEnabled(help: FailureHelp, opened: boolean): boolean {
  return !help.retryNeedsTerminal || opened;
}
