/** The two facts the app states once, in Settings. Everywhere else says less or points there. */
export const FACTS = [
  "Gossamr posts nothing to Jira or GitHub until you approve it. It never merges.",
  "Agents run with your own Claude Code settings, so they can push branches and use your own tools.",
] as const;

/** What limits an agent on GitHub, as the safety sheet says it. Kept short: the first-run strip shows it on one line with the purpose. */
export const AGENTS_ON_GITHUB = "On GitHub, agents run with your own Claude Code settings; see Agent safety.";
