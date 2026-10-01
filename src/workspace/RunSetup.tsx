import { useEffect, useState, type ReactNode } from "react";
import type { CloneChoice, ItemRef, Preflight, RunKind, RunReview } from "../types";
import { Icon, KIND_ICON } from "./AgentIcons";
import { Box, BoxTitle, Btn, CodeBox, Details, MONO_BLOCK, Sec, SheetFrame } from "./AgentSheet";
import { KIND_LABEL } from "./agentsLogic";
import { PromptParts } from "./RunPrompt";
import { RunPreflight } from "./RunPreflight";
import { COPY, START_STEPS, launchCommand, savedAsTyped, startBlock, worktreeBranch } from "./runSheetLogic";
import { useRunSetup, type SetupPhase } from "./runSetupStore";

const KINDS: { kind: RunKind; note: string }[] = [
  { kind: "investigate", note: "Read the code and logs, change nothing, report" },
  { kind: "triage", note: "Size it up" },
  { kind: "build", note: "Make the change" },
  { kind: "review", note: "Review a pull request" },
  { kind: "verify", note: "Check a change works" },
];

const FIELD = "w-full rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink outline-offset-2 disabled:opacity-60";

export interface SetupActions {
  close(): void;
  discard(): void;
  start(): void;
  chooseRepo(repo: string): void;
  chooseClone(path: string): void;
  dismissChanged(): void;
  /** Saves what is in the instruction box or the base field, when it differs from the draft. */
  commit(): void;
}

export interface SetupViewProps {
  item: ItemRef | null;
  ticketTitle: string | null;
  kind: RunKind;
  repo: string | null;
  repos: readonly string[];
  /** The repository can be changed here only when this sheet made the draft. */
  repoEditable: boolean;
  choice: CloneChoice | null;
  review: RunReview | null;
  preflight: Preflight | null;
  phase: SetupPhase;
  busy: boolean;
  error: string | null;
  changed: boolean;
  fromPip: boolean;
  instruction: string;
  onInstruction(text: string): void;
  onReset?(): void;
  base: string;
  onBase(text: string): void;
  wide: boolean;
  onWide(): void;
  on: SetupActions;
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
        {p.repos.length === 0 && <p className="m-0 text-ws-ink2">No repository is watched yet. Connect GitHub and watch the repository in Settings, then come back.</p>}
        {none && (
          <Box tone="warn" label="No clone found">
            <BoxTitle icon="alert" tone="warn">
              No clone of {p.repo} found
            </BoxTitle>
            <p className="m-0 text-ws-ink2">Gossamr looks in ~/Code, ~/Developer and ~/src, one level down, for a folder whose origin is {p.repo}. Clone it into one of them and open this again.</p>
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
        {KIND_LABEL[p.kind]} {p.item ? `${p.item.key}${p.ticketTitle ? `: ${p.ticketTitle}` : ""}` : "a task"}
      </h2>
      <p className="m-0 text-ws-ink2">Nothing runs until you press Start. You can stop it once it&apos;s working.</p>
    </div>
  );
}

function KindPicker({ kind }: { kind: RunKind }) {
  return (
    <Sec title="Kind of work">
      <div role="group" aria-label="Kind of work" className="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-1.5">
        {KINDS.map(({ kind: k, note }) => {
          const on = k === kind;
          const later = k !== "investigate";
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              disabled={later}
              title={later ? "Coming later" : undefined}
              className={`grid content-start gap-0.5 rounded-[9px] border px-2.5 py-2 text-left disabled:cursor-not-allowed ${on ? "border-ws-accent bg-ws-accent-soft shadow-[0_0_0_1px_var(--color-ws-accent)]" : "border-ws-sep2 bg-ws-win"} ${later ? "opacity-55" : ""}`}
            >
              <Icon name={KIND_ICON[k]} className={`size-[15px] ${on ? "text-ws-accent" : "text-ws-ink3"}`} />
              <b className="text-[13px] font-semibold">{KIND_LABEL[k]}</b>
              <small className="text-xs leading-snug text-ws-ink3">{later ? "Coming later" : note}</small>
            </button>
          );
        })}
      </div>
    </Sec>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 grid list-none gap-2 p-0 text-ws-ink2 [counter-reset:s]">{children}</ol>;
}

/** Why Start is off for what the sheet shows, or null. The button and the ⌘↵ shortcut both ask this. */
export function setupBlock(p: Pick<SetupViewProps, "review" | "preflight" | "phase" | "busy" | "changed" | "choice" | "repo" | "instruction" | "base">): string | null {
  return startBlock({
    draft: !!p.review,
    review: p.review,
    preflight: p.preflight,
    busy: p.phase === "preparing" || p.busy,
    starting: p.phase === "starting",
    changedBanner: p.changed,
    noClone: p.choice && p.choice.clones.length === 0 ? `No clone of ${p.repo} found` : null,
    repoMissing: !p.repo,
    typed: { instruction: p.instruction, base: p.base },
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
      <KindPicker kind={p.kind} />
      <Where p={p} />

      <Sec title="The prompt">
        {review ? (
          <PromptParts
            review={review}
            editor={{ text: p.instruction, disabled: phase === "starting", onChange: p.onInstruction, onBlur: on.commit, onReset: p.onReset }}
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
          </Details>
        )}
      </Sec>

      <Sec title="Before you approve">
        <RunPreflight preflight={preflight} checking={phase === "preparing" || p.busy} />
        <Box label="What agents can do">
          <p className="m-0 text-ws-ink">{COPY.runAsYou}</p>
          <p className="m-0 text-ws-ink2">{COPY.notALock}</p>
        </Box>
      </Sec>

      <Sec title="What happens when you press Start">
        <Steps>
          {START_STEPS.map((text, i) => (
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
  const saved = s.review?.instruction ?? "";
  const savedBase = s.review?.spec.base ?? "";
  useEffect(() => setInstruction(saved), [saved]);
  useEffect(() => setBase(savedBase), [savedBase]);

  const commit = async () => {
    const edit: { instruction?: string; base?: string } = {};
    if (s.review && instruction !== saved && instruction.trim()) edit.instruction = instruction;
    if (s.review && base.trim() && base.trim() !== savedBase) edit.base = base;
    if (Object.keys(edit).length) await useRunSetup.getState().saveEdit(edit);
  };
  const view: SetupViewProps = {
    item: s.item,
    ticketTitle: ticketTitle ?? s.title,
    kind: s.kind,
    repo: s.repo,
    repos: s.repos,
    repoEditable: s.ownDraft || !s.proposalId,
    choice: s.choice,
    review: s.review,
    preflight: s.preflight,
    phase: s.phase,
    busy: s.busy,
    error: s.error,
    changed: s.changed,
    fromPip: s.fromPip,
    instruction,
    onInstruction: setInstruction,
    onReset: s.initialInstruction && instruction !== s.initialInstruction ? () => setInstruction(s.initialInstruction!) : undefined,
    base,
    onBase: setBase,
    wide,
    onWide: () => setWide((w) => !w),
    on: {
      close: () => useRunSetup.getState().close(),
      discard: () => void useRunSetup.getState().discard(),
      start: () => void start(),
      chooseRepo: (repo) => void useRunSetup.getState().chooseRepo(repo),
      chooseClone: (path) => void useRunSetup.getState().chooseClone(path),
      dismissChanged: () => useRunSetup.getState().dismissChanged(),
      commit: () => void commit(),
    },
  };

  // Starts only what Start would start: the same checks, and only once the typed text is the saved draft.
  async function start() {
    if (setupBlock(view)) return;
    await commit();
    const now = useRunSetup.getState();
    if (now.error || !savedAsTyped(now.review, { instruction, base })) return;
    await now.start();
  }

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
