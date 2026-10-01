import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { itemKey } from "../lib/filter";
import { relativeTime } from "../lib/views";
import type { ContainerRef, FeedEntry, ItemRef, Proposal } from "../types";
import { allContainers, nameOf, pendingDrafts, useWorkspace } from "../workspaceStore";
import { CHIPS, CHIP_LABEL, SOURCE_LABEL, buildRows, codeVerb, draftsFor, groupByDay, initials, rowAt, rowId, shownSourceOf, coversAgents, sourcesFor, stepIndex, toCodeEntry, toRunEntries, verb, type ActivityChip, type ActivitySource, type CodeEntry, type RunEntry } from "./activityLogic";
import { GithubMark } from "./DevBits";
import { useDev } from "./devStore";
import { openOnGithub } from "./githubUi";
import { useActivity } from "./activityStore";
import { useAgentsFlag } from "./agentsFlag";
import { Icon } from "./AgentIcons";
import { useRuns } from "./runsStore";
import { LiveDraftCard } from "./DraftCard";
import { ProjectSwitcher } from "./FilterBar";
import { projectOf, withProject } from "./filters";
import { useActiveTab } from "./hooks";
import { showMe } from "./jump";
import { useTabs } from "./tabsStore";
import { StrayNotices } from "./WatchNotices";

export const feedRowId = (id: string) => `feed-${id}`;

export interface FeedRowProps {
  entry: FeedEntry;
  actor: string;
  title: string;
  now: Date;
  selected: boolean;
  /** The item is one the backend says is waiting on the person. */
  needsMe: boolean;
  /** False when the item has left the cache and can't be opened. */
  openable: boolean;
  position: number;
  total: number;
  onOpen(): void;
  onMarkRead(): void;
  onShow(): void;
}

const action = "rounded px-1.5 py-0.5 text-sm text-ws-ink3 hover:bg-ws-hover hover:text-ws-ink disabled:opacity-45";

export function FeedRow({ entry: e, actor, title, now, selected, needsMe, openable, position, total, onOpen, onMarkRead, onShow }: FeedRowProps) {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || !openable) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      onOpen();
    }
  };
  return (
    <article
      id={feedRowId(e.id)}
      tabIndex={0}
      aria-posinset={position}
      aria-setsize={total}
      aria-current={selected ? "true" : undefined}
      data-unread={e.unread ? "true" : undefined}
      onKeyDown={onKey}
      className={`group flex gap-3 rounded-lg px-2 py-2.5 outline-offset-[-2px] hover:bg-ws-hover ${selected ? "bg-ws-sel" : ""}`}
    >
      <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${e.unread ? "bg-ws-accent" : "bg-transparent"}`} />
      <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ws-accent-soft text-xs font-semibold text-ws-accent">
        {initials(actor)}
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" disabled={!openable} onClick={onOpen} className="block w-full text-left disabled:cursor-default">
          <span className={e.unread ? "font-semibold" : ""}>
            {actor} <span className="font-normal text-ws-ink2">{verb(e)}</span>{" "}
            <span className="font-mono text-sm font-semibold text-ws-ink2">{e.item.key}</span>
            <span className="font-normal text-ws-ink2"> {title}</span>
          </span>
          {e.text && <span className="mt-0.5 line-clamp-2 block text-ws-ink2 [overflow-wrap:anywhere]">{e.text}</span>}
        </button>
        <div className="mt-1 flex items-center gap-1 text-sm text-ws-ink3">
          <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
          {needsMe && <span className="ml-1 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Needs you</span>}
          <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {openable && (
              <button type="button" className={action} onClick={onShow}>
                Show me
              </button>
            )}
            {e.unread && (
              <button type="button" className={action} onClick={onMarkRead}>
                Mark read
              </button>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

export interface CodeRowProps {
  entry: CodeEntry;
  /** The linked ticket's title, when there is one in the cache. */
  ticketTitle: string | null;
  now: Date;
  selected: boolean;
  position: number;
  total: number;
  onOpen(): void;
  onMarkRead(): void;
  onOpenGithub(): void;
}

/** A GitHub event. It opens the linked ticket, or the pull request on GitHub when no ticket is known. */
export function CodeFeedRow({ entry: e, ticketTitle, now, selected, position, total, onOpen, onMarkRead, onOpenGithub }: CodeRowProps) {
  const openable = !!e.item || !!e.url;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || !openable) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      onOpen();
    }
  };
  return (
    <article
      id={feedRowId(e.id)}
      data-source="github"
      tabIndex={0}
      aria-posinset={position}
      aria-setsize={total}
      aria-current={selected ? "true" : undefined}
      data-unread={e.unread ? "true" : undefined}
      onKeyDown={onKey}
      className={`group flex gap-3 rounded-lg px-2 py-2.5 outline-offset-[-2px] hover:bg-ws-hover ${selected ? "bg-ws-sel" : ""}`}
    >
      <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${e.unread ? "bg-ws-accent" : "bg-transparent"}`} />
      <span aria-hidden title="GitHub" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ws-sel text-ws-ink2">
        <GithubMark className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" disabled={!openable} onClick={onOpen} className="block w-full text-left disabled:cursor-default">
          <span className={`block [overflow-wrap:anywhere] ${e.unread ? "font-semibold" : ""}`}>
            <span className="sr-only">{codeVerb(e.kind)}: </span>
            {e.text}
          </span>
          {e.item ? (
            <span className="mt-0.5 block text-ws-ink2 [overflow-wrap:anywhere]">
              <span className="font-mono text-sm font-semibold">{e.item.key}</span>
              {ticketTitle && <span> {ticketTitle}</span>}
            </span>
          ) : (
            <span className="mt-0.5 block text-sm text-ws-ink3">Not linked to a ticket. Opens on GitHub.</span>
          )}
        </button>
        <div className="mt-1 flex items-center gap-1 text-sm text-ws-ink3">
          <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
          <span className="rounded-full bg-ws-sel px-2 text-xs">{codeVerb(e.kind)}</span>
          {e.needsYou && e.unread && <span className="ml-1 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Needs you</span>}
          <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {e.url && (
              <button type="button" className={action} onClick={onOpenGithub}>
                Open on GitHub
              </button>
            )}
            {e.unread && (
              <button type="button" className={action} onClick={onMarkRead}>
                Mark read
              </button>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

export interface RunRowProps {
  entry: RunEntry;
  ticketTitle: string | null;
  now: Date;
  selected: boolean;
  position: number;
  total: number;
  onOpen(): void;
  onMarkRead(): void;
}

const RUN_CHIP: Record<RunEntry["kind"], string> = { started: "Started", needsYou: "Needs you", finished: "Finished", failed: "Failed" };

/** An agent run's change of state. It opens the run. */
export function RunFeedRow({ entry: e, ticketTitle, now, selected, position, total, onOpen, onMarkRead }: RunRowProps) {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || ev.key !== "Enter") return;
    ev.preventDefault();
    onOpen();
  };
  return (
    <article
      id={feedRowId(e.id)}
      data-source="agents"
      data-kind={e.kind}
      tabIndex={0}
      aria-posinset={position}
      aria-setsize={total}
      aria-current={selected ? "true" : undefined}
      data-unread={e.unread ? "true" : undefined}
      onKeyDown={onKey}
      className={`group flex gap-3 rounded-lg px-2 py-2.5 outline-offset-[-2px] hover:bg-ws-hover ${selected ? "bg-ws-sel" : ""}`}
    >
      <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${e.unread ? "bg-ws-accent" : "bg-transparent"}`} />
      <span aria-hidden title="Agents" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ws-pip-soft text-ws-pip">
        <Icon name="spark" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="block w-full text-left">
          <span className={`block [overflow-wrap:anywhere] ${e.unread ? "font-semibold" : ""}`}>{e.text}</span>
          {e.item && (
            <span className="mt-0.5 block text-ws-ink2 [overflow-wrap:anywhere]">
              <span className="font-mono text-sm font-semibold">{e.item.key}</span>
              {ticketTitle && <span> {ticketTitle}</span>}
            </span>
          )}
        </button>
        <div className="mt-1 flex items-center gap-1 text-sm text-ws-ink3">
          <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
          <span className="rounded-full bg-ws-sel px-2 text-xs">{RUN_CHIP[e.kind]}</span>
          {e.needsYou && e.unread && e.kind !== "needsYou" && <span className="ml-1 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Needs you</span>}
          <span className="ml-auto flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <button type="button" className={action} onClick={onOpen}>
              Open run
            </button>
            {e.unread && (
              <button type="button" className={action} onClick={onMarkRead}>
                Mark read
              </button>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

export function SourceBar({ source, sources, onChange }: { source: ActivitySource; sources: readonly ActivitySource[]; onChange(source: ActivitySource): void }) {
  return (
    <div role="group" aria-label="Source" className="flex flex-wrap gap-1.5">
      {sources.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={source === s}
          onClick={() => onChange(s)}
          className={`rounded-xl border px-2.5 py-px text-sm font-semibold ${source === s ? "border-ws-accent bg-ws-accent-soft text-ws-accent" : "border-ws-sep2 text-ws-ink2 hover:bg-ws-hover"}`}
        >
          {s === "github" && <GithubMark className="mr-1 inline size-3 align-[-1px]" />}
          {s === "agents" && <Icon name="spark" className="mr-1 inline size-3 align-[-1px]" />}
          {SOURCE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

export function DayHeading({ label }: { label: string }) {
  return <h3 className="sticky top-0 z-10 m-0 bg-ws-win px-2 pt-4 pb-1 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">{label}</h3>;
}

export function ChipBar({ chip, counts, onChange }: { chip: ActivityChip; counts: Partial<Record<ActivityChip, number>>; onChange(chip: ActivityChip): void }) {
  return (
    <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
      {CHIPS.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={chip === c}
          onClick={() => onChange(c)}
          className={`rounded-xl px-2.5 py-px text-sm font-semibold ${chip === c ? "bg-ws-accent-soft text-ws-accent" : "text-ws-ink2 hover:bg-ws-hover"}`}
        >
          {c === "drafts" && <span aria-hidden>✦ </span>}
          {CHIP_LABEL[c]}
          {!!counts[c] && <span className="ml-1 font-normal">{counts[c]}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 py-12 text-center text-ws-ink3">
      {children}
    </p>
  );
}

const EMPTY_AGENTS = "Nothing from your agents yet. When one starts, needs you, finishes or fails, it shows up here.";

const EMPTY_GITHUB = "No GitHub activity yet. Pull request events from the repositories you watch show up here.";

const EMPTY: Record<ActivityChip, string> = {
  all: "Nothing has happened on your tickets yet.",
  needsMe: "You're all caught up.",
  mentions: "Nobody has mentioned you.",
  comments: "No comments yet.",
  status: "No status changes yet.",
  assigned: "Nothing has been assigned to you.",
  drafts: "No drafts waiting. Ask Pip, or drag a card to a new column.",
};

function Drafts({ drafts }: { drafts: Proposal[] }) {
  if (!drafts.length) return <EmptyNote>{EMPTY.drafts}</EmptyNote>;
  return (
    <ul className="m-0 grid list-none gap-3 p-0 pt-3" aria-label="Drafts waiting for you">
      {drafts.map((p) => (
        <li key={p.id}>
          <LiveDraftCard proposal={p} />
        </li>
      ))}
    </ul>
  );
}

export function ActivityView() {
  const tab = useActiveTab();
  const project: ContainerRef | null = projectOf(tab.filter);
  const containers = useWorkspace((s) => s.containers);
  const items = useWorkspace((s) => s.items);
  const names = useWorkspace((s) => s.names);
  const needsMe = useWorkspace((s) => s.needsMe);
  const proposals = useWorkspace((s) => s.proposals);
  const selected = useTabs((s) => s.selected);
  const { chip, entries, next, status, error, loadingMore, unread: jiraUnread, codeUnread, source, codeEvents, codeRead, runRead } = useActivity();
  const hasGithub = useWorkspace((s) => s.connections.some((c) => c.kind === "github"));
  const agentsOn = useAgentsFlag((s) => s.enabled);
  const runs = useRuns((s) => s.runs);
  const byChange = useDev((s) => s.byChange);
  const sources = sourcesFor({ github: hasGithub, agents: agentsOn });
  const shownSource: ActivitySource = shownSourceOf(source, sources);
  // A source that went away (agents turned off) must not stay chosen in the store, or the feed keeps loading it.
  useEffect(() => {
    if (source !== shownSource) useActivity.getState().setSource(shownSource);
  }, [source, shownSource]);
  const runEntries = useMemo(() => (agentsOn ? toRunEntries(runs, runRead, Date.now()) : []), [agentsOn, runs, runRead]);
  const inProject = (item: ItemRef | null) => !project || (!!item && items[itemKey(item)]?.container.connectionId === project.connectionId && items[itemKey(item)]?.container.externalId === project.externalId);
  const agentUnread = runEntries.filter((e) => e.unread && inProject(e.item)).length;
  const unread = shownSource === "jira" ? jiraUnread : shownSource === "github" ? codeUnread : shownSource === "agents" ? agentUnread : jiraUnread + codeUnread + agentUnread;
  const [now, setNow] = useState(() => new Date());
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const projectKey = project ? `${project.connectionId}:${project.externalId}` : "";
  const drafts = useMemo(() => draftsFor(pendingDrafts({ proposals }), items, project), [proposals, items, project]);
  const byKey = useMemo(() => new Map(Object.values(items).map((i) => [i.item.key.toUpperCase(), i.item] as const)), [items]);
  const codeEntries = useMemo(() => codeEvents.flatMap((e) => toCodeEntry(e, { byKey, byChange, read: codeRead, now: Date.now() }) ?? []), [codeEvents, byKey, byChange, codeRead]);
  const rows = useMemo(
    () => buildRows({ source: shownSource, chip, container: project, jira: entries, more: next !== null, code: codeEntries, agents: runEntries, containerOf: (ref: ItemRef) => items[itemKey(ref)]?.container ?? null }),
    [shownSource, chip, projectKey, entries, next, codeEntries, runEntries, items],
  );
  const groups = useMemo(() => groupByDay(rows.map((row) => ({ at: rowAt(row), row })), now), [rows, now]);

  useEffect(() => {
    useActivity.getState().showProject(project);
    // The project object changes identity with every filter edit; its key is what matters.
  }, [projectKey]);

  useEffect(() => setNow(new Date()), [entries, codeEvents]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && void useActivity.getState().loadMore());
    io.observe(el);
    return () => io.disconnect();
  }, [next, entries.length]);

  const open = (e: FeedEntry) => {
    useTabs.getState().select(itemKey(e.item));
    void useActivity.getState().markRead(e.unread ? [e.id] : []);
  };

  const openRun = (e: RunEntry) => {
    useActivity.getState().markRunRead([e.id]);
    useRuns.getState().openRun(e.runId);
  };

  const openCode = (e: CodeEntry) => {
    useActivity.getState().markCodeRead([e.id]);
    if (e.item && items[itemKey(e.item)]) useTabs.getState().select(itemKey(e.item));
    else if (e.url) openOnGithub(e.url);
  };

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const onKey = (ev: globalThis.KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || target.closest?.("input, textarea, select, [contenteditable], [role=dialog], #peek-sheet")) return;
      const delta = ev.key === "j" ? 1 : ev.key === "k" ? -1 : 0;
      if (delta) {
        const articles = [...(list.current?.querySelectorAll<HTMLElement>("article[id^='feed-']") ?? [])];
        if (!articles.length) return;
        ev.preventDefault();
        const to = articles[stepIndex(articles.indexOf(target.closest("article") as HTMLElement), delta, articles.length)];
        to?.focus();
        to?.scrollIntoView({ block: "nearest" });
      } else if (ev.key === "m") {
        const id = target.closest?.("article")?.id.replace(/^feed-/, "");
        const row = rowsRef.current.find((r) => rowId(r) === id);
        if (row?.entry.unread) {
          ev.preventDefault();
          if (row.source === "agents") useActivity.getState().markRunRead([row.entry.id]);
          else if (row.source === "github") useActivity.getState().markCodeRead([row.entry.id]);
          else void useActivity.getState().markRead([row.entry.id]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let position = 0;
  const total = rows.length;
  const showDrafts = chip === "drafts";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ws-sep px-6 py-2.5">
        <h2 className="m-0 text-base font-semibold">Activity</h2>
        <ProjectSwitcher
          containers={allContainers({ containers })}
          value={project}
          onChange={(p) => useTabs.getState().setFilter(withProject(tab.filter, p))}
        />
        {sources.length > 2 && <SourceBar source={shownSource} sources={sources} onChange={(s) => useActivity.getState().setSource(s)} />}
        <ChipBar chip={chip} counts={{ needsMe: unread, drafts: drafts.length }} onChange={(c) => useActivity.getState().setChip(c)} />
        {!showDrafts && (
          <button type="button" disabled={unread === 0} onClick={() => (coversAgents(shownSource) && useActivity.getState().markRunRead(runEntries.filter((e) => e.unread && inProject(e.item)).map((e) => e.id)), void useActivity.getState().markAllRead(codeEntries.filter((e) => e.unread && (!project || (!!e.item && items[itemKey(e.item)]?.container.connectionId === project.connectionId && items[itemKey(e.item)]?.container.externalId === project.externalId))).map((e) => e.id)))} className="ml-auto text-sm text-ws-ink3 underline disabled:no-underline disabled:opacity-45">
            Mark all read
          </button>
        )}
      </header>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        <div className="mx-auto max-w-[780px]">
          <StrayNotices />
          {showDrafts ? (
            <Drafts drafts={drafts} />
          ) : status === "error" ? (
            <div role="alert" className="grid justify-items-center gap-2 py-12 text-ws-blocked">
              <p className="m-0">{error}</p>
              <button type="button" className="rounded-md border border-ws-sep2 px-3 py-1 text-ws-ink" onClick={() => void useActivity.getState().reload()}>
                Try again
              </button>
            </div>
          ) : status !== "ready" ? (
            <EmptyNote>Loading activity…</EmptyNote>
          ) : rows.length === 0 ? (
            <EmptyNote>{shownSource === "github" ? EMPTY_GITHUB : shownSource === "agents" ? EMPTY_AGENTS : EMPTY[chip]}</EmptyNote>
          ) : (
            <div role="feed" aria-label="Activity" aria-busy={loadingMore}>
              {groups.map((g) => (
                <section key={g.day} aria-label={g.label}>
                  <DayHeading label={g.label} />
                  {g.entries.map(({ row }) => {
                    if (row.source === "agents") {
                      const r = row.entry;
                      const linked = r.item ? items[itemKey(r.item)] : undefined;
                      return (
                        <RunFeedRow
                          key={r.id}
                          entry={r}
                          ticketTitle={linked?.title ?? null}
                          now={now}
                          selected={false}
                          position={++position}
                          total={total}
                          onOpen={() => openRun(r)}
                          onMarkRead={() => useActivity.getState().markRunRead([r.id])}
                        />
                      );
                    }
                    if (row.source === "github") {
                      const c = row.entry;
                      const linked = c.item ? items[itemKey(c.item)] : undefined;
                      return (
                        <CodeFeedRow
                          key={c.id}
                          entry={c}
                          ticketTitle={linked?.title ?? null}
                          now={now}
                          selected={!!c.item && selected === itemKey(c.item)}
                          position={++position}
                          total={total}
                          onOpen={() => openCode(c)}
                          onMarkRead={() => useActivity.getState().markCodeRead([c.id])}
                          onOpenGithub={() => (useActivity.getState().markCodeRead([c.id]), c.url && openOnGithub(c.url))}
                        />
                      );
                    }
                    const e = row.entry;
                    const key = itemKey(e.item);
                    const item = items[key];
                    return (
                      <FeedRow
                        key={e.id}
                        entry={e}
                        actor={e.actorName ?? nameOf({ names }, e.actor).replace("Unassigned", "Someone")}
                        title={e.itemTitle ?? item?.title ?? ""}
                        now={now}
                        selected={selected === key}
                        needsMe={needsMe.has(key) && e.unread}
                        openable={!!item}
                        position={++position}
                        total={total}
                        onOpen={() => open(e)}
                        onMarkRead={() => void useActivity.getState().markRead([e.id])}
                        onShow={() => (open(e), showMe(e.item))}
                      />
                    );
                  })}
                </section>
              ))}
              <div ref={sentinel} className="grid place-items-center py-4">
                {next && (
                  <button type="button" disabled={loadingMore} onClick={() => void useActivity.getState().loadMore()} className="rounded-md border border-ws-sep2 px-3 py-1 text-sm text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
