import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CloneChoice, ContainerRef, FreshCopy, ItemRef, Preflight, RunKind, RunReview, WorkContainer } from "../types";
import { Icon, KIND_ICON } from "./AgentIcons";
import { Box, BoxTitle, Btn, CodeBox, Details, MONO_BLOCK, Sec, SheetFrame } from "./AgentSheet";
import { KIND_LABEL } from "./agentsLogic";
import { PrPicker } from "./PrPicker";
import { PromptParts, ReportExtras } from "./RunPrompt";
import { RunPreflight } from "./RunPreflight";
import { COPY, homeShort, kindBlock, launchCommand, permissionMode, repoShortage, savedAsTyped, startBlock, startSteps, ticketlessShape, worktreeBranch, type RepoShortage } from "./runSheetLogic";
import { containerKey } from "../lib/filter";
import { useRunSetup, type PrSearch, type RunEditFields, type SetupPhase } from "./runSetupStore";
import { useTabs } from "./tabsStore";
import { allContainers, useWorkspace } from "../workspaceStore";

const KINDS: { kind: RunKind; note: string }[] = [
  { kind: "investigate", note: "Read the code and logs, change nothing, report" },
  { kind: "triage", note: "Size it up, find owners and duplicates" },
  { kind: "plan", note: "Write a plan for you to edit and approve" },
  { kind: "build", note: "Make the change on its own branch" },
  { kind: "review", note: "Read a pull request, change nothing" },
  { kind: "verify", note: "Check that a change works" },
];

const FIELD = "w-full rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink outline-offset-2 disabled:opacity-60";

export interface SetupActions {
  close(): void;
  discard(): void;
  start(): void;
  chooseRepo(repo: string): void;
  chooseClone(path: string): void;
  cloneFresh(): void;
  retryRepos(): void;
  openSettings(): void;
  dismissChanged(): void;
  /** Saves what is in the instruction box or the base field, when it differs from the draft. */
  commit(): void;
  chooseKind(kind: RunKind): void;
  chooseProject(project: ContainerRef): void;
  searchPrs(query: string): void;
  choosePr(number: number): void;
  setAllowPush(on: boolean): void;
  setReport?(on: boolean): void;
  trustFolder?(path: string): void;
  recheck?(): void;
  refreshPlan?(): void;
  removePlan?(): void;
  refreshBuildAccount?(): void;
  removeBuildAccount?(): void;
}

export interface SetupViewProps {
  item: ItemRef | null;
  ticketTitle: string | null;
  kind: RunKind;
  /** The kind can be changed here only when this sheet made the draft. */
  kindEditable: boolean;
  pr: number | null;
  prs: PrSearch;
  repo: string | null;
  repos: readonly string[];
  /** Why there is nothing to choose, or that the list could not be loaded; null when there is a choice. */
  shortage: RepoShortage | null;
  reposError: string | null;
  /** The repository can be changed here only when this sheet made the draft. */
  repoEditable: boolean;
  /** An investigation with no ticket: it asks for the person's own question and ends as a draft ticket in `project`. */
  ticketless: boolean;
  project: ContainerRef | null;
  projects: readonly WorkContainer[];
  choice: CloneChoice | null;
  review: RunReview | null;
  preflight: Preflight | null;
  phase: SetupPhase;
  busy: boolean;
  error: string | null;
  cloning: boolean;
  cloneError: string | null;
  rechecking?: boolean;
  changed: boolean;
  fromPip: boolean;
  instruction: string;
  onInstruction(text: string): void;
  onReset?(): void;
  base: string;
  onBase(text: string): void;
  /** The plan text as typed, for a build made from a plan. */
  plan?: string;
  onPlan?(text: string): void;
  /** The builder's account as typed, for a review made from a build. */
  buildAccount?: string;
  onBuildAccount?(text: string): void;
  wide: boolean;
  onWide(): void;
  /** The Agents setting that offers the result tool is on. */
  reportOffered?: boolean;
  on: SetupActions;
}

const SHORTAGE_COPY: Record<Exclude<RepoShortage, "loading" | "failed">, string> = {
  connect: "GitHub isn't connected. Connect it in Settings and watch the repository the agent should work in.",
  watch: "GitHub is connected, but no repository is watched yet. Choose the repositories to watch in Settings.",
};

function RepoShortageNote({ shortage, error, on }: { shortage: RepoShortage; error: string | null; on: SetupActions }) {
  if (shortage === "loading") return <p className="m-0 text-ws-ink2">Loading your repositories…</p>;
  if (shortage === "failed") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-ws-ink2">
        <span>Couldn't load the watched repositories{error ? `: ${error}` : "."}</span>
        <Btn onClick={on.retryRepos}>Retry</Btn>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-ws-ink2">
      <span>{SHORTAGE_COPY[shortage]}</span>
      <Btn onClick={on.openSettings}>Open Settings</Btn>
    </div>
  );
}

function FreshOffer({ p, fresh }: { p: SetupViewProps; fresh: FreshCopy }) {
  const folder = homeShort(fresh.path);
  return (
    <div className="grid gap-2 border-t border-ws-sep pt-2">
      <b className="text-ws-ink">Or use a fresh copy in {folder}</b>
      {fresh.occupied ? (
        <p className="m-0 text-ws-ink2">That folder already exists and isn&apos;t a clone of {p.repo}. Move it away to let Gossamr make the copy there.</p>
      ) : (
        <>
          <p className="m-0 text-ws-ink2">Gossamr makes that folder and runs this, nowhere else:</p>
          <CodeBox text={fresh.command} what="the clone command" wrap />
          <p className="m-0 text-xs text-ws-ink3">
            It signs in the way git does in your shell, and the repository&apos;s own hooks don&apos;t run.
            {fresh.ghFallback && " If git can't sign in, it tries gh repo clone with your GitHub CLI login."} The first agent in a new folder needs you to trust it once: the checks below offer a button that opens Terminal there.
          </p>
        </>
      )}
      {p.cloneError && (
        <div role="alert" className="grid gap-1.5 text-ws-blocked">
          <span className="[overflow-wrap:anywhere]">{p.cloneError}</span>
          <span className="text-ws-ink2">If it is a sign-in problem, run this once in Terminal and try again, or clone the repository yourself into ~/Code.</span>
          <CodeBox text="gh auth setup-git" what="the command" />
        </div>
      )}
      <div>
        <Btn disabled={fresh.occupied || p.cloning || p.phase !== "ready"} onClick={p.on.cloneFresh}>
          {p.cloning ? "Cloning…" : `Clone into ${folder}`}
        </Btn>
      </div>
    </div>
  );
}

function Where({ p }: { p: SetupViewProps }) {
  const { choice, review } = p;
  const chosen = review?.spec.clonePath;
  const none = !!choice && choice.clones.length === 0;
  return (
    <Sec title="Where it runs">
      <div className="grid gap-2">
        <label className="grid gap-1">
          <span className="text-xs text-ws-ink3">Repository</span>
          {p.repoEditable || !p.repo ? (
            <select aria-label="Repository" value={p.repo ?? ""} disabled={p.phase !== "ready"} onChange={(ev) => p.on.chooseRepo(ev.target.value)} className={FIELD}>
              <option value="" disabled>
                Choose a repository…
              </option>
              {p.repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-ws-ink">{p.repo}</span>
          )}
        </label>
        {p.shortage && <RepoShortageNote shortage={p.shortage} error={p.reposError} on={p.on} />}
        {none && (
          <Box tone="warn" label="No clone found">
            <BoxTitle icon="alert" tone="warn">
              No clone of {p.repo} found
            </BoxTitle>
            <p className="m-0 text-ws-ink2">Gossamr looks in ~/Code, ~/Developer and ~/src, one level down, for a folder whose origin is {p.repo}. Clone it into one of them and open this again.</p>
            {choice.fresh && <FreshOffer p={p} fresh={choice.fresh} />}
          </Box>
        )}
        {choice && choice.clones.length > 0 && (
          <div role="radiogroup" aria-label="Which clone" className="grid gap-1.5">
            {choice.clones.map((c) => {
              const on = c.path === chosen;
              return (
                <button
                  key={c.path}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={p.busy || p.phase !== "ready"}
                  onClick={() => !on && p.on.chooseClone(c.path)}
                  className={`grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-[9px] border px-2.5 py-2 text-left disabled:cursor-default ${on ? "border-ws-accent bg-ws-accent-soft" : "border-ws-sep bg-ws-win hover:bg-ws-hover"}`}
                >
                  <span aria-hidden className={`mt-0.5 grid size-3.5 place-items-center rounded-full border-[1.5px] ${on ? "border-ws-accent" : "border-ws-ink3"}`}>
                    {on && <span className="size-1.5 rounded-full bg-ws-accent" />}
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate font-mono text-sm text-ws-ink">{c.path}</span>
                    <span className="text-xs text-ws-ink3">
                      on {c.branch}
                      {c.dirty ? ", has uncommitted changes" : ""}
                      {choice.picked === c.path ? ", the one you chose last time" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
            <p className="m-0 text-xs text-ws-ink3">The agent gets a separate worktree of this clone. Your own files and branch are not touched by the launch.</p>
          </div>
        )}
        {review && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5">
            <label className="grid gap-1">
              <span className="text-xs text-ws-ink3">Branch from</span>
              <input aria-label="Branch from" value={p.base} disabled={p.busy} onChange={(ev) => p.onBase(ev.target.value)} onBlur={p.on.commit} className={`${FIELD} font-mono`} />
            </label>
            <div className="grid gap-1">
              <span className="text-xs text-ws-ink3">New branch for this run</span>
              <span className="truncate py-1 font-mono text-ws-ink" title={worktreeBranch(review.spec.name)}>
                {worktreeBranch(review.spec.name)}
              </span>
            </div>
          </div>
        )}
      </div>
    </Sec>
  );
}

function Heading({ p }: { p: SetupViewProps }) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-ws-ink2">
        <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ws-pip bg-ws-pip-soft px-2 text-xs leading-[1.6] font-semibold text-ws-pip">
          <Icon name="spark" className="size-[11px]" />
          Draft: start an agent
        </span>
        <span className="text-sm text-ws-ink3">{p.fromPip ? "Proposed by Pip. Nothing has started." : "Started by you, still a draft you approve."}</span>
      </div>
      <h2 className="m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">
        {p.ticketless ? "Investigate something (no ticket)" : `${KIND_LABEL[p.kind]} ${p.item ? `${p.item.key}${p.ticketTitle ? `: ${p.ticketTitle}` : ""}` : "a task"}`}
      </h2>
      <p className="m-0 text-ws-ink2">Nothing runs until you press Start. You can stop it once it&apos;s working.</p>
      {p.fromPip && p.ticketless && <p className="m-0 text-ws-ink2">Pip wrote the question below because no ticket covers it. It is the prompt in full, and you can change it before you start.</p>}
      {p.review?.spec.buildFromRun && p.review.buildAccount && (
        <p className="m-0 text-ws-ink2">
          This review follows build run {p.review.spec.buildFromRun}, pinned to the pull request&apos;s commit as GitHub has it now. What the builder says it did is its own part of the prompt below, in full, and you can edit it before you start. The reviewer is told to check it against the diff and the ticket, not to believe it.
        </p>
      )}
      {p.review?.spec.planFromRun && p.review.plan && (
        <p className="m-0 text-ws-ink2">
          This build follows the plan from run {p.review.spec.planFromRun}. The plan is its own part of the prompt below, in full, and you can edit it before you start. If the plan turns out to be wrong, the agent is told to stop and say so instead of working around it.
        </p>
      )}
    </div>
  );
}

function KindPicker({ p }: { p: SetupViewProps }) {
  const locked = !p.kindEditable || p.phase === "starting";
  return (
    <Sec title="Kind of work">
      <div role="group" aria-label="Kind of work" className="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-1.5">
        {KINDS.map(({ kind: k, note }) => {
          const on = k === p.kind;
          const needsTicket = k === "build" && !p.item;
          const off = locked && !on;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              disabled={off || needsTicket}
              title={needsTicket ? "Build needs a ticket" : undefined}
              onClick={() => !on && p.on.chooseKind(k)}
              className={`grid content-start gap-0.5 rounded-[9px] border px-2.5 py-2 text-left disabled:cursor-not-allowed ${on ? "border-ws-accent bg-ws-accent-soft shadow-[0_0_0_1px_var(--color-ws-accent)]" : "border-ws-sep2 bg-ws-win"} ${off || needsTicket ? "opacity-55" : ""}`}
            >
              <Icon name={KIND_ICON[k]} className={`size-[15px] ${on ? "text-ws-accent" : "text-ws-ink3"}`} />
              <b className="text-[13px] font-semibold">{KIND_LABEL[k]}</b>
              <small className="text-xs leading-snug text-ws-ink3">{needsTicket ? "Needs a ticket" : note}</small>
            </button>
          );
        })}
      </div>
    </Sec>
  );
}

/** The result tool: asking for it is part of what the person approves, and the prompt below shows the exact words. */
function ReportOption({ p }: { p: SetupViewProps }) {
  const on = !!p.review?.spec.report;
  return (
    <Sec title="Result">
      <label className="flex items-start gap-2">
        <input type="checkbox" aria-label="Let the agent report its result to Gossamr" checked={on} disabled={!p.review || p.busy || p.phase !== "ready"} onChange={(ev) => p.on.setReport?.(ev.target.checked)} className="mt-1" />
        <span className="grid gap-0.5">
          <b className="font-semibold text-ws-ink">Let the agent report its result to Gossamr</b>
          <span className="text-ws-ink2">The prompt asks it to call one extra tool, report_result, with its result. The tool only records what it says on this run; it can&apos;t write to Jira or reach anything else, and what you get is still a draft. The agent writes its full answer too, and Gossamr reads that when the tool isn&apos;t used.</span>
        </span>
      </label>
    </Sec>
  );
}

function PushOption({ p }: { p: SetupViewProps }) {
  const on = !!p.review?.spec.allowPush;
  const mode = permissionMode(p.preflight);
  return (
    <Sec title="Pushing">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={on} disabled={!p.review || p.busy || p.phase !== "ready"} onChange={(ev) => p.on.setAllowPush(ev.target.checked)} className="mt-1" />
        <span className="grid gap-0.5">
          <b className="font-semibold text-ws-ink">Push its branch and open a draft pull request</b>
          <span className="text-ws-ink2">On by default. The prompt tells it to push the branch, open a draft pull request, never mark it ready and never merge it, and to put the link in its note for Jira. Off, the prompt tells it to commit on its own branch and not push.</span>
        </span>
      </label>
      <p className="m-0 text-xs text-ws-ink3">
        Either way this is a request in the prompt, not a lock. Agents run with your own permission mode{mode ? ` (${mode})` : ""}, so nothing technical stops a push whether this is ticked or not.
      </p>
    </Sec>
  );
}

function ProjectPicker({ p }: { p: SetupViewProps }) {
  const locked = p.phase !== "ready" || p.busy;
  return (
    <Sec title="Where the ticket goes">
      <p className="m-0 text-ws-ink2">There is no ticket for this. When the agent finishes, Gossamr drafts one new ticket from what it found, in this project. You read it, edit it and approve it; nothing is created in Jira before that, and the agent never picks the project.</p>
      {p.projects.length === 0 ? (
        <p className="m-0 text-ws-ink2">There is no project to put it in. Choose the projects to watch in Settings.</p>
      ) : (
        <label className="grid gap-1">
          <span className="text-xs text-ws-ink3">Project</span>
          <select
            aria-label="Project for the ticket"
            value={p.project ? containerKey(p.project) : ""}
            disabled={locked}
            onChange={(ev) => {
              const next = p.projects.find((c) => containerKey(c.ref) === ev.target.value);
              if (next) p.on.chooseProject(next.ref);
            }}
            className={FIELD}
          >
            {!p.project && (
              <option value="" disabled>
                Choose a project…
              </option>
            )}
            {p.project && !p.projects.some((c) => containerKey(c.ref) === containerKey(p.project!)) && <option value={containerKey(p.project)}>{p.project.externalId}</option>}
            {p.projects.map((c) => (
              <option key={containerKey(c.ref)} value={containerKey(c.ref)}>
                {c.key} · {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </Sec>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 grid list-none gap-2 p-0 text-ws-ink2 [counter-reset:s]">{children}</ol>;
}

/** Why Start is off for what the sheet shows, or null. The button and the ⌘↵ shortcut both ask this. */
export function setupBlock(p: Pick<SetupViewProps, "review" | "preflight" | "phase" | "busy" | "changed" | "choice" | "repo" | "instruction" | "base" | "kind" | "item" | "pr"> & Partial<Pick<SetupViewProps, "ticketless" | "project" | "plan" | "buildAccount">>): string | null {
  return startBlock({
    draft: !!p.review,
    review: p.review,
    preflight: p.preflight,
    busy: p.phase === "preparing" || p.busy,
    starting: p.phase === "starting",
    changedBanner: p.changed,
    noClone: p.choice && p.choice.clones.length === 0 ? `No clone of ${p.repo} found` : null,
    repoMissing: !p.repo,
    kindBlock: kindBlock(p.kind, p.item, p.pr),
    typed: { instruction: p.instruction, base: p.base, plan: p.review?.plan ? (p.plan ?? p.review.plan) : undefined, buildAccount: p.review?.buildAccount ? (p.buildAccount ?? p.review.buildAccount) : undefined },
    ticketless: p.ticketless ? { project: !!p.project } : undefined,
  });
}

/** The sheet that shows a run draft in full and starts it. Starting is the only way to approve; it carries the digest of what is on screen. */
export function RunSetupView(p: SetupViewProps) {
  const { review, preflight, phase, on } = p;
  const blocked = setupBlock(p);
  return (
    <SheetFrame
      label="Start an agent"
      title={p.item?.key ?? "New agent"}
      draft
      wide={p.wide}
      min={600}
      onWide={p.onWide}
      onClose={on.close}
      hint={
        <>
          draft · <kbd className="font-sans">esc</kbd> close · <kbd className="font-sans">⌘</kbd>
          <kbd className="font-sans">↵</kbd> start
        </>
      }
      footer={
        <>
          <Btn tone="primary" icon="play" disabled={blocked !== null} onClick={on.start}>
            {phase === "starting" ? "Starting…" : "Start agent"}
          </Btn>
          <Btn onClick={on.close}>Close</Btn>
          {review && (
            <Btn tone="ghost" onClick={on.discard} title="Skips this draft">
              Discard draft
            </Btn>
          )}
          <span role="status" className={`ml-auto text-sm ${blocked && phase !== "starting" ? "text-ws-ink2" : "text-ws-ink3"}`}>
            {blocked ?? COPY.startsNow}
          </span>
        </>
      }
    >
      <Heading p={p} />
      {p.changed && (
        <Box tone="warn" label="The draft changed">
          <BoxTitle icon="alert" tone="warn">
            {COPY.changed}
          </BoxTitle>
          <p className="m-0 text-ws-ink2">Something about this draft changed after you opened it, so nothing started. What is below is what would run now.</p>
          <div>
            <Btn onClick={on.dismissChanged}>I&apos;ve read it</Btn>
          </div>
        </Box>
      )}
      {p.error && (
        <p role="alert" className="m-0 text-ws-blocked [overflow-wrap:anywhere]">
          {p.error}
        </p>
      )}

      {p.ticketless ? (
        <ProjectPicker p={p} />
      ) : (
        <Sec title="Ticket">
          {p.item ? (
            <p className="m-0">
              <span className="font-mono font-semibold text-ws-ink2">{p.item.key}</span>
              {p.ticketTitle && <span className="ml-2 text-ws-ink">{p.ticketTitle}</span>}
            </p>
          ) : (
            <p className="m-0 text-ws-ink2">No ticket: a free-form task.</p>
          )}
        </Sec>
      )}
      <KindPicker p={p} />
      {p.kind === "build" && <PushOption p={p} />}
      {(p.reportOffered || p.review?.spec.report) && <ReportOption p={p} />}
      {p.kind === "review" && p.repo && (
        <PrPicker
          key={p.repo}
          repo={p.repo}
          pr={p.pr}
          review={review}
          prs={p.prs}
          initialQuery={p.item?.key ?? ""}
          disabled={!p.kindEditable || phase !== "ready" || p.busy || !!review?.spec.buildFromRun}
          onSearch={on.searchPrs}
          onChoose={on.choosePr}
        />
      )}
      <Where p={p} />

      <Sec title="The prompt">
        {review ? (
          <PromptParts
            review={review}
            editor={{
              question: p.ticketless,
              text: p.instruction,
              disabled: phase === "starting",
              onChange: p.onInstruction,
              onBlur: on.commit,
              onReset: p.onReset,
              plan: review.plan ? { text: p.plan ?? review.plan, disabled: phase !== "ready" || p.busy, onChange: p.onPlan ?? (() => {}), onBlur: on.commit, onRefresh: on.refreshPlan ?? (() => {}), onRemove: on.removePlan ?? (() => {}) } : undefined,
              account: review.buildAccount ? { text: p.buildAccount ?? review.buildAccount, disabled: phase !== "ready" || p.busy, onChange: p.onBuildAccount ?? (() => {}), onBlur: on.commit, onRefresh: on.refreshBuildAccount ?? (() => {}), onRemove: on.removeBuildAccount ?? (() => {}) } : undefined,
            }}
          />
        ) : (
          <p role="status" className="m-0 text-ws-ink3">
            {phase === "preparing" ? "Getting the draft ready…" : "The prompt shows here once there is a clone to work in."}
          </p>
        )}
        {review && (
          <Details summary="What Gossamr adds for the model">
            <pre className={MONO_BLOCK}>{review.guard}</pre>
            <p className="m-0 text-ws-ink2">{COPY.guardNote}</p>
            <ReportExtras report={review.report} />
          </Details>
        )}
      </Sec>

      <Sec title="Before you approve">
        <RunPreflight preflight={preflight} checking={phase === "preparing" || p.busy} steps={p.on.trustFolder && p.on.recheck ? { trust: p.on.trustFolder, recheck: p.on.recheck, rechecking: !!p.rechecking } : undefined} />
        <Box label="What agents can do">
          <p className="m-0 text-ws-ink">{COPY.runAsYou}</p>
          <p className="m-0 text-ws-ink2">{COPY.notALock}</p>
        </Box>
      </Sec>

      <Sec title="What happens when you press Start">
        <Steps>
          {startSteps(p.ticketless).map((text, i) => (
            <li key={i} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2">
              <span aria-hidden className="grid size-5 place-items-center rounded-full bg-ws-hover text-[11px] font-bold">
                {i + 1}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </Steps>
        {review && (
          <Details summary="Show the exact command">
            <CodeBox text={launchCommand(review.spec, p.item?.key ?? null, review.guard, review.prompt)} what="the command" wrap />
            <p className="m-0 text-xs text-ws-ink3">Shown as a shell would read it. Gossamr hands each part to Claude as a separate argument, so nothing goes through a shell.</p>
          </Details>
        )}
      </Sec>
    </SheetFrame>
  );
}

/** The sheet for `useRunSetup`: it keeps the typed instruction and base until they are saved, and starts on ⌘↵. */
export function RunSetup({ ticketTitle }: { ticketTitle: string | null }) {
  const s = useRunSetup();
  const [wide, setWide] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [base, setBase] = useState("");
  const [plan, setPlan] = useState("");
  const savedPlan = s.review?.plan ?? "";
  useEffect(() => setPlan(savedPlan), [savedPlan]);
  const [buildAccount, setBuildAccount] = useState("");
  const savedAccount = s.review?.buildAccount ?? "";
  useEffect(() => setBuildAccount(savedAccount), [savedAccount]);
  const saved = s.review?.instruction ?? "";
  const savedBase = s.review?.spec.base ?? "";
  useEffect(() => setInstruction(saved), [saved]);
  useEffect(() => setBase(savedBase), [savedBase]);

  const commit = async () => {
    const edit: RunEditFields = {};
    if (s.review && instruction !== saved && instruction.trim()) edit.instruction = instruction;
    if (s.review && base.trim() && base.trim() !== savedBase) edit.base = base;
    if (s.review?.plan && plan.trim() && plan !== savedPlan) edit.plan = plan;
    if (s.review?.buildAccount && buildAccount.trim() && buildAccount !== savedAccount) edit.buildAccount = buildAccount;
    if (Object.keys(edit).length) await useRunSetup.getState().saveEdit(edit);
  };
  const githubConnected = useWorkspace((w) => w.connections.some((c) => c.kind === "github"));
  const containers = useWorkspace((w) => w.containers);
  const projects = useMemo(() => allContainers({ containers }), [containers]);
  const view: SetupViewProps = {
    item: s.item,
    ticketTitle: ticketTitle ?? s.title,
    kind: s.kind,
    kindEditable: s.ownDraft || !s.proposalId,
    pr: s.pr,
    prs: s.prs,
    repo: s.repo,
    repos: s.repos,
    shortage: repoShortage({ repos: s.repos, loading: s.reposStatus === "loading", failed: s.reposStatus === "failed", githubConnected }),
    reposError: s.reposError,
    repoEditable: (s.ownDraft || !s.proposalId) && !s.planFromRun,
    ticketless: ticketlessShape(s.item, s.kind),
    project: s.project,
    projects,
    choice: s.choice,
    review: s.review,
    preflight: s.preflight,
    phase: s.phase,
    busy: s.busy,
    error: s.error,
    cloning: s.cloning,
    cloneError: s.cloneError,
    rechecking: s.rechecking,
    changed: s.changed,
    fromPip: s.fromPip,
    instruction,
    onInstruction: setInstruction,
    onReset: s.initialInstruction && instruction !== s.initialInstruction ? () => setInstruction(s.initialInstruction!) : undefined,
    base,
    onBase: setBase,
    plan,
    onPlan: setPlan,
    buildAccount,
    onBuildAccount: setBuildAccount,
    wide,
    onWide: () => setWide((w) => !w),
    reportOffered: s.reportAvailable,
    on: {
      close: () => useRunSetup.getState().close(),
      discard: () => void useRunSetup.getState().discard(),
      start: () => void start(),
      chooseRepo: (repo) => void useRunSetup.getState().chooseRepo(repo),
      chooseClone: (path) => void useRunSetup.getState().chooseClone(path),
      cloneFresh: () => void useRunSetup.getState().cloneFresh(),
      retryRepos: () => void useRunSetup.getState().reloadRepos(),
      openSettings: () => {
        useRunSetup.getState().close();
        useTabs.getState().openSettings("watching");
      },
      dismissChanged: () => useRunSetup.getState().dismissChanged(),
      commit: () => void commit(),
      chooseKind: (kind) => void useRunSetup.getState().chooseKind(kind),
      chooseProject: (project) => void useRunSetup.getState().chooseProject(project),
      searchPrs: (query) => void useRunSetup.getState().searchPrs(query),
      choosePr: (number) => void useRunSetup.getState().choosePr(number),
      setAllowPush: (on) => void useRunSetup.getState().saveEdit({ allowPush: on }),
      setReport: (on) => void useRunSetup.getState().saveEdit({ report: on }),
      trustFolder: (path) => void useRunSetup.getState().trustFolder(path),
      recheck: () => void useRunSetup.getState().recheck(),
      refreshPlan: () => void useRunSetup.getState().refreshPlan(),
      removePlan: () => void useRunSetup.getState().saveEdit({ plan: "" }),
      refreshBuildAccount: () => void useRunSetup.getState().refreshBuildAccount(),
      removeBuildAccount: () => void useRunSetup.getState().saveEdit({ buildAccount: "" }),
    },
  };

  // Starts only what Start would start: the same checks, and only once the typed text is the saved draft.
  async function start() {
    if (setupBlock(view)) return;
    await commit();
    const now = useRunSetup.getState();
    if (now.error || !savedAsTyped(now.review, { instruction, base, plan, buildAccount })) return;
    await now.start();
  }

  const waitingOnTrust = s.preflight?.rows.some((r) => r.action?.type === "trustFolder") ?? false;
  useEffect(() => {
    if (!waitingOnTrust) return;
    const back = () => void useRunSetup.getState().recheck();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [waitingOnTrust]);

  useEffect(() => {
    const frame = () => document.getElementById("agent-sheet");
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        // The sheet's own fields start it; a field behind the sheet or a palette on top of it must not.
        if (document.querySelector("[role=combobox]")) return;
        const field = document.activeElement;
        if (field instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName) && !frame()?.contains(field)) return;
        ev.preventDefault();
        void start();
        return;
      }
      if (ev.key !== "Escape" || document.querySelector("[role=combobox]")) return;
      // Captured so the ticket peek behind the sheet doesn't also close on the same key.
      ev.preventDefault();
      const field = document.activeElement;
      if (field instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName)) return void field.blur();
      useRunSetup.getState().close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return <RunSetupView {...view} />;
}
