import type { Run } from "../types";

export const INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";
export const INSTALL_URL = "https://code.claude.com/docs/en/setup";

export type FailureAct = "terminal" | "install" | "start";

export interface FailureHelp {
  kind: "untrustedFolder" | "notSignedIn" | "claudeMissing" | "noClone" | "capReached";
  /** One line for a card or row. */
  summary: string;
  /** The sheet's explanation. */
  detail: string;
  primary: { label: string; act: FailureAct } | null;
  /** The exact text for someone who would rather use their own terminal. */
  command: { text: string; note: string | null } | null;
  /** Retry waits for the person to have used Terminal (or copied the command) when there is something to do there first. */
  retryNeedsTerminal: boolean;
}

/** `path` as one shell word, so the copied command works for a folder with spaces or quotes in its name. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

const sentence = (text: string | null | undefined, fallback: string) => (text?.trim() || fallback).replace(/\.?$/, ".");

/** What to offer for a failed run that never got a session. Null for anything else. */
export function failureHelp(run: Run): FailureHelp | null {
  if (run.state !== "failed" || run.shortId) return null;
  const failure = run.failure;
  switch (failure?.type) {
    case "untrustedFolder":
      return {
        kind: "untrustedFolder",
        summary: "Claude asks you once per folder before it will work there.",
        detail: `Claude hasn't been trusted in ${failure.path} yet, so it won't start an agent there. Terminal opens in that folder with Claude: accept its trust question, then close it and retry. Claude asks because a cloned repository's own hooks, tools and settings run with the agent. Gossamr doesn't change Claude's settings for you.`,
        primary: { label: "Trust this folder in Terminal", act: "terminal" },
        command: { text: `cd ${shellQuote(failure.path)} && claude`, note: null },
        retryNeedsTerminal: true,
      };
    case "notSignedIn":
      return {
        kind: "notSignedIn",
        summary: "Claude isn't signed in.",
        detail: "Terminal opens with Claude in this run's folder. Type /login, finish signing in, then close it and retry.",
        primary: { label: "Open Terminal to sign in", act: "terminal" },
        command: { text: "claude", note: "Then type /login." },
        retryNeedsTerminal: true,
      };
    case "claudeMissing":
      return {
        kind: "claudeMissing",
        summary: "Claude Code isn't installed, or Gossamr can't find it.",
        detail: "Agents are Claude Code sessions, so Gossamr needs the claude command. Install it, then retry.",
        primary: { label: "Open the install page", act: "install" },
        command: { text: INSTALL_COMMAND, note: null },
        retryNeedsTerminal: false,
      };
    case "noClone":
      return {
        kind: "noClone",
        summary: "The clone this run was set up for can't be used any more.",
        detail: `${sentence(run.error, "The folder is gone or isn't a clone of the repository.")} Start the agent again and choose a clone of ${run.spec.repo}.`,
        primary: { label: "Start it again and choose a clone", act: "start" },
        command: null,
        retryNeedsTerminal: false,
      };
    case "capReached":
      return {
        kind: "capReached",
        summary: "Too many agents are running at once.",
        detail: `${sentence(run.error, "The limit on agents running at once is reached.")} Gossamr never starts more than that. Stop one or wait for one to finish, then retry.`,
        primary: null,
        command: null,
        retryNeedsTerminal: false,
      };
    default:
      return null;
  }
}

/** Whether Retry can be pressed: always for a run that never got a session, once the step in Terminal was taken where there is one. */
export function retryEnabled(help: FailureHelp, opened: boolean): boolean {
  return !help.retryNeedsTerminal || opened;
}
