import type { WorkFolder } from "../types";
import { Btn, Sec } from "./AgentSheet";

export const INCLUDE_IF_WARNING = "Your git settings choose an address by folder. Add a rule for ~/Gossamr/agents/<owner>/ to use it in Gossamr's clones too.";

/** Settings > Agents > Where agents work: the folder, who commits there, and a way to see it in Finder. */
export function WorkFolderSection({ workFolder, onReveal }: { workFolder: WorkFolder | null; onReveal(): void }) {
  return (
    <Sec title="Where agents work">
      <div className="grid gap-2">
        <p className="m-0 text-ws-ink2">
          Agents work in Gossamr&apos;s own clones in ~/Gossamr/agents, one per repository, each agent in its own worktree and branch. Gossamr clones a repository the first time an agent works on it, and fetches before each agent starts. Your clones in ~/Code and other folders aren&apos;t used or changed, so Claude Code, T3 Code and your own work there stay apart.
        </p>
        {workFolder && (
          <p className="selectable m-0 text-ws-ink2" data-work-folder-address>
            {workFolder.commitEmail ? `Commits in Gossamr's clones are by ${workFolder.commitEmail}.` : "Git has no email address set for commits in Gossamr's clones."}
          </p>
        )}
        {workFolder?.includeIf && (
          <p role="note" className="m-0 text-ws-warn">
            {INCLUDE_IF_WARNING}
          </p>
        )}
        <div>
          <Btn icon="folder" onClick={onReveal}>
            Reveal in Finder
          </Btn>
        </div>
      </div>
    </Sec>
  );
}
