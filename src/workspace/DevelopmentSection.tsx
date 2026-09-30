import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { diffStat, filesLabel, NO_PR_HINT, orderLinks, provenanceHint, reviewLine } from "../lib/devLinks";
import type { CodeChange, DevLink, ItemRef, PullRequestDetail, WorkItem } from "../types";
import { itemKey } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { BranchIcon, ChecksMark, CommitIcon, PullIcon, ReviewChip, StatePill } from "./DevBits";
import { useDev } from "./devStore";
import { codeWatch } from "./domains";
import { openOnGithub, useGithubUi } from "./githubUi";
import { SectionCard } from "./PeekParts";
import { keyInitials } from "./projects";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";
import { agoText, watchedReposLine } from "./watchLogic";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const small = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm font-semibold hover:bg-ws-hover disabled:opacity-45";

function Who({ login }: { login: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-ws-sel text-[8px] font-semibold text-ws-ink2">
        {keyInitials(login)}
      </span>
      <span className="min-w-0 truncate">{login}</span>
    </span>
  );
}

const Dot = () => (
  <span aria-hidden className="text-ws-sep2">
    ·
  </span>
);

function Stats({ change }: { change: CodeChange }) {
  const stat = diffStat(change);
  if (!stat) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold text-ws-done">+{stat.additions}</span>
      <span className="font-semibold text-ws-blocked">−{stat.deletions}</span>
      {stat.files !== null && <span>{filesLabel(stat.files)}</span>}
    </span>
  );
}

const shortSha = (c: CodeChange) => c.sha?.slice(0, 7) ?? "";

const refOf = (c: CodeChange) => (c.kind === "pullRequest" ? `${c.repo}#${c.number}` : c.kind === "commit" ? `${c.repo}@${shortSha(c)}` : c.repo);

export interface DetailState {
  status: "loading" | "ready" | "error";
  detail?: PullRequestDetail;
  error?: string;
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h4 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">{title}</h4>
      {children}
    </div>
  );
}

const FILE_STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C" };

export function PullDetail({ change, state, now, onOpen, onRetry }: { change: CodeChange; state: DetailState; now: Date; onOpen(): void; onRetry(): void }) {
  return (
    <div className="grid gap-3 border-t border-ws-sep bg-ws-bar px-3 py-3 text-sm" data-detail={change.externalId}>
      {state.status === "loading" && (
        <p role="status" className="m-0 text-ws-ink3">
          Loading the files and commits…
        </p>
      )}
      {state.status === "error" && (
        <div role="alert" className="grid gap-1.5 text-ws-blocked">
          <p className="m-0 [overflow-wrap:anywhere]">{state.error}</p>
          <button type="button" onClick={onRetry} className={`${small} justify-self-start text-ws-ink`}>
            Try again
          </button>
        </div>
      )}
      {state.detail && (
        <>
          {change.body.trim() && <p className="m-0 line-clamp-3 text-ws-ink2 [overflow-wrap:anywhere]">{change.body.trim()}</p>}
          <DetailBlock title={`Files changed (${state.detail.files.length}${state.detail.filesTruncated ? "+" : ""})`}>
            {state.detail.files.length === 0 ? (
              <p className="m-0 text-ws-ink3">No files listed.</p>
            ) : (
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {state.detail.files.map((f) => (
                  <li key={f.path} className="flex items-baseline gap-2">
                    <span aria-hidden className="w-3 shrink-0 font-mono text-xs text-ws-ink3">
                      {FILE_STATUS[f.status] ?? "·"}
                    </span>
                    <span className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{f.path}</span>
                    <span className="shrink-0 font-mono text-xs">
                      <span className="text-ws-done">+{f.additions}</span> <span className="text-ws-blocked">−{f.deletions}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {state.detail.filesTruncated && <p className="m-0 text-ws-ink3">More files changed than are listed here.</p>}
          </DetailBlock>
          {state.detail.commits.length > 0 && (
            <DetailBlock title={`Recent commits (${state.detail.commits.length})`}>
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {[...state.detail.commits].reverse().slice(0, 6).map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-2">
                    <code className="shrink-0 text-xs text-ws-ink3">{c.sha.slice(0, 7)}</code>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{c.message.split("\n")[0]}</span>
                    <span className="shrink-0 text-xs text-ws-ink3">{agoText(c.at, now)}</span>
                  </li>
                ))}
              </ul>
            </DetailBlock>
          )}
          <DetailBlock title="Reviewers">
            {state.detail.reviews.length === 0 && state.detail.change.reviewers.length === 0 ? (
              <p className="m-0 text-ws-ink3">Nobody has been asked to review yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
                {state.detail.reviews.map((r) => (
                  <li key={r.id} className="flex items-center gap-1.5">
                    <Who login={r.reviewer.accountId} />
                    <ReviewChip review={r.state} />
                  </li>
                ))}
                {state.detail.change.reviewers
                  .filter((p) => !state.detail!.reviews.some((r) => r.reviewer.accountId === p.accountId))
                  .map((p) => (
                    <li key={p.accountId} className="flex items-center gap-1.5">
                      <Who login={p.accountId} />
                      <ReviewChip review="requested" />
                    </li>
                  ))}
              </ul>
            )}
          </DetailBlock>
        </>
      )}
      <div>
        <button type="button" onClick={onOpen} className={small}>
          Open on GitHub
        </button>
      </div>
    </div>
  );
}

export interface ChangeRowProps {
  link: DevLink;
  now: Date;
  expanded: boolean;
  detail: DetailState | undefined;
  onToggle(): void;
  onOpen(url: string): void;
  onRetry(): void;
}

export function ChangeRow({ link, now, expanded, detail, onToggle, onOpen, onRetry }: ChangeRowProps) {
  const c = link.change;
  const pull = c.kind === "pullRequest";
  const Icon = pull ? <PullIcon state={c.state} className="size-4" /> : c.kind === "branch" ? <BranchIcon className="size-4" /> : <CommitIcon className="size-4" />;
  const body = (
    <>
      <span aria-hidden className="mt-0.5 text-ws-ink3">
        {Icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex min-w-0 items-start gap-2">
          <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${c.kind === "branch" ? "font-mono text-sm" : "font-medium"} ${c.state === "closed" && pull ? "text-ws-ink3" : ""}`}>{c.title}</span>
          <StatePill change={c} />
          {pull && <ChecksMark checks={c.checks} />}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-ws-ink3">
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{refOf(c)}</span>
          {c.author && (
            <>
              <Dot />
              <Who login={c.author.accountId} />
            </>
          )}
          <Dot />
          <span title={`Updated ${new Date(c.updatedAt).toLocaleString()}`}>{agoText(c.updatedAt, now)}</span>
          {pull && diffStat(c) && (
            <>
              <Dot />
              <Stats change={c} />
            </>
          )}
          {pull && reviewLine(c.review) && <ReviewChip review={c.review} />}
        </span>
        {c.kind === "branch" && <span className="text-sm text-ws-ink2">{NO_PR_HINT}</span>}
      </span>
    </>
  );
  const box = "grid min-w-0 rounded-lg border border-ws-sep";
  if (!pull) {
    return (
      <li title={provenanceHint(link.provenance)} className={`${box} grid-cols-[minmax(0,1fr)_auto] items-start gap-2 p-2.5`}>
        <div className="flex min-w-0 gap-2.5">{body}</div>
        <button type="button" onClick={() => onOpen(c.url)} className={`${small} shrink-0`}>
          Open on GitHub
        </button>
      </li>
    );
  }
  return (
    <li title={provenanceHint(link.provenance)} className={`${box} overflow-hidden ${expanded ? "border-ws-sep2" : ""}`}>
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-w-0 gap-2.5 p-2.5 text-left hover:bg-ws-hover">
        {body}
        <svg aria-hidden viewBox="0 0 16 16" className={`mt-1 size-3.5 shrink-0 text-ws-ink3 transition-transform ${expanded ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {expanded && <PullDetail change={c} state={detail ?? { status: "loading" }} now={now} onOpen={() => onOpen(c.url)} onRetry={onRetry} />}
    </li>
  );
}

export interface DevelopmentViewProps {
  itemKey: string;
  /** Null while the cache is being read. */
  links: DevLink[] | null;
  error: string | null;
  now: Date;
  searching: boolean;
  /** Which repositories tickets are matched against, for the empty state. */
  watched: string | null;
  expanded: string | null;
  details: Record<string, DetailState>;
  collapsed?: boolean;
  onToggleSection?(): void;
  onSearch(): void;
  onToggle(change: CodeChange): void;
  onOpen(url: string): void;
  onRetryDetail(change: CodeChange): void;
  onRetry(): void;
  onManage(): void;
}

export function DevelopmentView(p: DevelopmentViewProps) {
  const links = p.links ? orderLinks(p.links) : [];
  return (
    <SectionCard id="development" title="Development" count={p.links ? links.length : undefined} collapsed={p.collapsed} onToggle={p.onToggleSection}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 min-w-0 flex-1 text-sm text-ws-ink3">Pull requests, branches and commits that name {p.itemKey}.</p>
        <button type="button" disabled={p.searching} onClick={p.onSearch} className={small}>
          {p.searching ? "Searching GitHub…" : "Search GitHub for this ticket"}
        </button>
      </div>
      {p.error && (
        <div role="alert" className="grid gap-1.5 text-ws-blocked">
          <p className="m-0 [overflow-wrap:anywhere]">{p.error}</p>
          <button type="button" onClick={p.onRetry} className={`${small} justify-self-start text-ws-ink`}>
            Try again
          </button>
        </div>
      )}
      {!p.links && !p.error && (
        <p role="status" className="m-0 text-ws-ink3">
          Loading…
        </p>
      )}
      {p.links && links.length === 0 && !p.error && (
        <div className="grid gap-1.5 text-ws-ink2">
          <p className="m-0">
            Nothing {p.watched ?? "in your watched repositories"} names {p.itemKey} yet. Put the key in a branch name, pull request title or commit message and it shows up here after the next sync.
          </p>
          <button type="button" onClick={p.onManage} className="justify-self-start text-sm text-ws-accent underline">
            Manage repositories
          </button>
        </div>
      )}
      {links.length > 0 && (
        <ul aria-label="Linked code" className="m-0 grid list-none gap-2 p-0">
          {links.map((l) => (
            <ChangeRow
              key={l.change.externalId}
              link={l}
              now={p.now}
              expanded={p.expanded === l.change.externalId}
              detail={p.details[l.change.externalId]}
              onToggle={() => p.onToggle(l.change)}
              onOpen={p.onOpen}
              onRetry={() => p.onRetryDetail(l.change)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function ConnectBanner({ onConnect }: { onConnect(): void }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-ws-sep2 bg-ws-bar px-3 py-1.5 text-sm text-ws-ink2">
      <span className="min-w-0 flex-1">Connect GitHub to see the PRs for this ticket</span>
      <button type="button" onClick={onConnect} className="rounded-md px-2 py-0.5 font-semibold text-ws-accent hover:bg-ws-hover">
        Connect GitHub
      </button>
    </div>
  );
}

/** The linked pull requests, branches and commits of the open ticket, read from the cache and kept current. */
export function Development({ item, collapsed, onToggle, onCount }: { item: WorkItem; collapsed: boolean; onToggle(): void; onCount(n: number | undefined): void }) {
  const backend = useBackend();
  const ref: ItemRef = item.item;
  const key = itemKey(ref);
  const hasGithub = useWorkspace((s) => s.connections.some((c) => c.kind === "github"));
  const watch = useWorkspace((s) => s.watch);
  const codeStates = useMemo(() => codeWatch(watch), [watch]);
  const [links, setLinks] = useState<DevLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [now, setNow] = useState(() => new Date());
  const seq = useRef(0);

  const load = () => {
    if (!backend) return;
    const mine = ++seq.current;
    backend.devLinks(ref).then(
      (found) => {
        if (mine !== seq.current) return;
        setLinks(found);
        setError(null);
        setNow(new Date());
      },
      (e) => mine === seq.current && setError(messageOf(e)),
    );
  };

  useEffect(() => {
    setLinks(null);
    setError(null);
    setExpanded(null);
    setDetails({});
    if (!hasGithub) return;
    load();
    return backend?.onDevLinksChanged(() => {
      load();
      void useDev.getState().refreshItem(ref);
    });
  }, [key, hasGithub, backend]);

  useEffect(() => onCount(hasGithub ? (links?.length ?? 0) : undefined), [hasGithub, links]);

  const search = async () => {
    if (!backend || searching) return;
    setSearching(true);
    const before = links?.length ?? 0;
    try {
      const found = await backend.devLinksLive(ref);
      setLinks(found);
      setError(null);
      setNow(new Date());
      void useDev.getState().refreshItem(ref);
      const fresh = Math.max(0, found.length - before);
      useToasts.getState().push(found.length === 0 ? `Nothing on GitHub names ${ref.key} yet.` : `Found ${plural(found.length, "link")} for ${ref.key}${fresh ? ` (${fresh} new)` : ""}.`, "info");
    } catch (e) {
      useToasts.getState().push(`Couldn't search GitHub for ${ref.key}: ${messageOf(e)}`);
    } finally {
      setSearching(false);
    }
  };

  const fetchDetail = (change: CodeChange) => {
    if (!backend || change.number === null) return;
    setDetails((d) => ({ ...d, [change.externalId]: { status: "loading" } }));
    backend.codePullRequest({ connectionId: change.connectionId, repo: change.repo, number: change.number }).then(
      (detail) => setDetails((d) => ({ ...d, [change.externalId]: { status: "ready", detail } })),
      (e) => setDetails((d) => ({ ...d, [change.externalId]: { status: "error", error: messageOf(e) } })),
    );
  };

  if (!hasGithub) return <ConnectBanner onConnect={() => useGithubUi.getState().openConnect()} />;

  return (
    <DevelopmentView
      itemKey={ref.key}
      links={links}
      error={error}
      now={now}
      searching={searching}
      watched={watchedReposLine(codeStates)}
      expanded={expanded}
      details={details}
      collapsed={collapsed}
      onToggleSection={onToggle}
      onSearch={() => void search()}
      onToggle={(c) => {
        const open = expanded === c.externalId;
        setExpanded(open ? null : c.externalId);
        if (!open && !details[c.externalId]?.detail) fetchDetail(c);
      }}
      onOpen={(url) => void openOnGithub(url)}
      onRetryDetail={fetchDetail}
      onRetry={load}
      onManage={() => useTabs.getState().openSettings("watching")}
    />
  );
}
