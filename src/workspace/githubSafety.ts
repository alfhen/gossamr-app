/** What Gossamr does on GitHub, said once for the settings that mention it. */
export const GITHUB_SAFETY =
  "Gossamr reads pull requests, branches and checks. It posts a review only when you approve a review draft, and a build pushes only its own branch to a draft pull request. It never merges.";

/** What limits a build on GitHub, as the safety sheet says it: it runs as the person, and the branch rule is a request that applies only with Pushing ticked. */
export const BUILD_ON_GITHUB = "On GitHub, a build runs as you: when Pushing is ticked its prompt asks it to push only its own branch to a draft pull request. That is a request, not a lock; see Agent safety.";
