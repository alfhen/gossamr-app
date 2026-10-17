/** What Gossamr does on GitHub, said once for the settings that mention it. */
export const GITHUB_SAFETY =
  "Gossamr reads pull requests, branches and checks. It posts a review only when you approve a review draft, and a Build pushes only its own branch to a draft pull request. It never merges.";

/** What limits a build on GitHub, as the safety sheet says it: it runs as the person, and the branch rule is a request: always in a workstream, and elsewhere only with Pushing ticked. Kept short: the first-run strip shows it on one line with the purpose. */
export const BUILD_ON_GITHUB = "On GitHub, a Build runs as you. In a workstream or with Pushing ticked, it is asked to push only its branch to a draft pull request: a request, not a lock; see Agent safety.";
