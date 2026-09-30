import { itemKey } from "../lib/filter";
import type { PullRef } from "../lib/githubUrl";
import { useWorkspace } from "../workspaceStore";
import { useDev } from "./devStore";
import { openOnGithub } from "./githubUi";
import { showMe } from "./jump";

const pageOf = (ref: PullRef) => `https://github.com/${ref.repo}/pull/${ref.number}`;

/** Opens a pull request's ticket when one is known, else its page on GitHub. */
export async function openPull(ref: PullRef): Promise<void> {
  const ws = useWorkspace.getState();
  const linked = useDev.getState().byChange.get(`pr:${ref.repo}#${ref.number}`);
  if (linked && ws.items[itemKey(linked)]) {
    showMe(linked);
    return;
  }
  const github = ws.connections.find((c) => c.kind === "github");
  if (github && ws.backend) {
    try {
      const { change } = await ws.backend.codePullRequest({ connectionId: github.id, repo: ref.repo, number: ref.number });
      const keys = new Set(change.linkedKeys.map((k) => k.toUpperCase()));
      const item = Object.values(useWorkspace.getState().items).find((i) => keys.has(i.item.key.toUpperCase()));
      if (item) {
        showMe(item.item);
        return;
      }
    } catch {
      // A repository that isn't watched can't be read; its page on GitHub still opens.
    }
  }
  openOnGithub(pageOf(ref));
}
