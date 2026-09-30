import { useEffect, useMemo, useState } from "react";
import type { Backend } from "../backend/types";
import { useBackend } from "../backend/useBackend";
import type { CatalogEntry, ConnectionInfo, Footprint, WatchChange, WatchDepth, WatchMode, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useToasts } from "./toasts";
import { ArchivedBadge, Badge, CatalogError, ChooseWatch, OfflineNote, PermissionBadge, RepoName, ScrollSentinel, SearchBox } from "./WatchPicker";
import { useCatalog, type Catalog } from "./useCatalog";
import { codeWatch, workWatch } from "./domains";
import { activityHint, agoText, count, graceDaysLeft, graceLine, matchesQuery, nounFor, repoParts, settingsRows, suggestionChips, type Noun, type SettingsRow } from "./watchLogic";

const seg = "rounded-md px-2 py-px text-xs font-semibold";

export function DepthToggle({ row, noun, onChange }: { row: Pick<SettingsRow, "name" | "depth">; noun: Noun; onChange(depth: WatchDepth): void }) {
  const options: { value: WatchDepth; label: string; title: string }[] = [
    { value: "involved", label: "Involved", title: "Only tickets you are on or were mentioned in" },
    { value: "whole", label: `Whole ${noun.one}`, title: `Every ticket in the ${noun.one}, for triage` },
  ];
  return (
    <div role="radiogroup" aria-label={`Depth for ${row.name}`} className="inline-flex rounded-lg bg-ws-sel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={row.depth === o.value}
          title={o.title}
          onClick={() => row.depth !== o.value && onChange(o.value)}
          className={`${seg} whitespace-nowrap ${row.depth === o.value ? "bg-ws-win text-ws-ink shadow-sm" : "text-ws-ink2"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface SettingsRowViewProps {
  row: SettingsRow;
  noun: Noun;
  now: Date;
  /** Everything mode watches it already, so only pinning is a choice. */
  pinOnly: boolean;
  onDepth(depth: WatchDepth): void;
  onPin(pinned: boolean): void;
  onUnwatch(): void;
  onUndo(): void;
}

export function SettingsRowView({ row, noun, now, pinOnly, onDepth, onPin, onUnwatch, onUndo }: SettingsRowViewProps) {
  const inGrace = row.unwatchedAt !== null;
  const code = noun.domain === "code";
  const synced = code ? `${row.cachedItems} ${row.cachedItems === 1 ? "change" : "changes"} synced` : `${row.cachedItems} ${row.cachedItems === 1 ? "ticket" : "tickets"} synced`;
  return (
    <li className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-ws-sep px-3 py-2 last:border-b-0 ${inGrace ? "bg-ws-bar" : ""}`}>
      <span className={inGrace ? "opacity-45" : ""}>
        <Badge k={code ? repoParts(row.key).name : row.key} />
      </span>
      <div className="min-w-0">
        <div className={`truncate ${inGrace ? "text-ws-ink3" : ""}`}>
          {code ? (
            <RepoName k={row.key} />
          ) : (
            <>
              <span className="font-semibold">{row.name}</span>
              <span className="ml-1.5 text-sm text-ws-ink3">{row.key}</span>
            </>
          )}
        </div>
        <div className="text-sm text-ws-ink3" title={code ? "Pull requests, branches and commits" : undefined}>
          {inGrace ? graceLine(graceDaysLeft(row.unwatchedAt!, now)) : synced}
          {row.inaccessible && !inGrace && (
            <span className="ml-2 font-semibold text-ws-warn" title={`The tracker refused this ${noun.one}; what was synced stays visible.`}>
              Can't be reached
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {inGrace ? (
          <button type="button" onClick={onUndo} className="rounded-md px-2 py-0.5 text-sm font-semibold text-ws-accent hover:bg-ws-hover">
            Undo
          </button>
        ) : (
          <>
            {!pinOnly && !code && <DepthToggle row={row} noun={noun} onChange={onDepth} />}
            {!code && (
              <button
                type="button"
                aria-label={row.pinned ? `Unpin ${row.name} from the rail` : `Pin ${row.name} to the rail`}
                aria-pressed={row.pinned}
                title={row.pinned ? "Pinned to the rail" : "Pin to the rail"}
                onClick={() => onPin(!row.pinned)}
                className={`grid size-7 place-items-center rounded-md text-base hover:bg-ws-hover ${row.pinned ? "text-ws-warn" : "text-ws-ink3"}`}
              >
                <span aria-hidden>{row.pinned ? "★" : "☆"}</span>
              </button>
            )}
            {!pinOnly && (
              <button type="button" aria-label={`Unwatch ${row.name}`} onClick={onUnwatch} className="rounded-md px-2 py-0.5 text-sm text-ws-ink2 hover:bg-ws-hover">
                Unwatch
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function ModeSwitch({ mode, noun, onChange }: { mode: WatchMode; noun: Noun; onChange(mode: "everything" | "selected"): void }) {
  const current = mode === "selected" ? "selected" : "everything";
  const options = [
    { value: "everything", label: "Everything" },
    { value: "selected", label: `Selected ${noun.many}` },
  ] as const;
  return (
    <div role="radiogroup" aria-label="What to watch" className="inline-flex rounded-lg bg-ws-sel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={current === o.value}
          onClick={() => current !== o.value && onChange(o.value)}
          className={`rounded-md px-3 py-1 text-sm font-semibold ${current === o.value ? "bg-ws-win text-ws-ink shadow-sm" : "text-ws-ink2"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ModeConfirm({ to, noun, onConfirm, onCancel }: { to: "everything" | "selected"; noun: Noun; onConfirm(): void; onCancel(): void }) {
  return (
    <div role="alertdialog" aria-label="Change what you watch" className="grid gap-2 rounded-lg border border-ws-warn bg-ws-bar px-3 py-2.5 text-sm">
      <p className="m-0 text-ws-ink">
        {to === "everything"
          ? `Watch every ${noun.one} you can see? Syncing gets slower, ${noun.domain === "code" ? "pull requests" : "tickets"} from ${noun.many} you never use show up, and Pip can read all of it.`
          : `Watch only the ${noun.many} you choose? The rest stop syncing and leave your views. You pick them next, and nothing changes until you save.`}
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onConfirm} className="rounded-md bg-ws-accent px-3 py-1 font-semibold text-white">
          {to === "everything" ? "Watch everything" : `Choose ${noun.many}…`}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-1 text-ws-ink2 hover:bg-ws-hover">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SuggestionChips({ chips, noun, onWatch }: { chips: Footprint[]; noun: Noun; onWatch(f: Footprint): void }) {
  if (!chips.length) return null;
  return (
    <div className="grid gap-1.5">
      <span className="text-sm text-ws-ink3">Suggested from your last 90 days</span>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((f) => (
          <button
            key={f.container.externalId}
            type="button"
            title={activityHint(f) ?? undefined}
            aria-label={`Watch ${f.name}`}
            onClick={() => onWatch(f)}
            className="rounded-full border border-ws-sep2 px-2.5 py-px text-sm text-ws-ink2 hover:border-ws-accent hover:text-ws-accent"
          >
            <span aria-hidden>+ </span>
            {f.key}
            {f.assigned > 0 && <span className="ml-1 text-ws-ink3">{f.assigned} assigned</span>}
          </button>
        ))}
      </div>
      <span className="sr-only">Adds the {noun.one} to what you watch</span>
    </div>
  );
}

export function FindRow({ entry, code = false, now = new Date(), onWatch }: { entry: CatalogEntry; code?: boolean; now?: Date; onWatch(): void }) {
  return (
    <li className={`flex items-center gap-2.5 border-b border-ws-sep px-3 py-1.5 last:border-b-0 ${code && entry.archived ? "opacity-60" : ""}`}>
      <Badge k={code ? entry.name : entry.key} />
      {code ? (
        <>
          <span className="min-w-0 flex-1 truncate">
            <RepoName k={entry.key} />
          </span>
          {entry.archived && <ArchivedBadge />}
          <PermissionBadge kind={entry.kind} />
          {entry.lastActive && (
            <span className="hidden w-24 shrink-0 text-right text-sm text-ws-ink3 sm:block" title={`Last push ${new Date(entry.lastActive).toLocaleString()}`}>
              pushed {agoText(entry.lastActive, now)}
            </span>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{entry.name}</span>
          <span className="ml-1.5 text-sm text-ws-ink3">{entry.key}</span>
          {entry.archived && <span className="ml-2 rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink3">archived</span>}
        </span>
      )}
      <button type="button" aria-label={`Watch ${entry.name}`} onClick={onWatch} className="rounded-md px-2 py-0.5 text-sm font-semibold text-ws-accent hover:bg-ws-hover">
        Watch
      </button>
    </li>
  );
}

export interface WatchCardViewProps {
  title: string;
  account: string;
  noun: Noun;
  state: WatchState;
  rows: SettingsRow[];
  query: string;
  now: Date;
  sync: { text: string; tone: "ok" | "busy" | "error" };
  chips: Footprint[];
  find: Pick<Catalog, "entries" | "status" | "error" | "offline" | "hasMore" | "loadingMore">;
  /** The mode change waiting for a yes. */
  confirm: "everything" | "selected" | null;
  onQuery(q: string): void;
  onMode(to: "everything" | "selected"): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  onChip(f: Footprint): void;
  onDepth(row: SettingsRow, depth: WatchDepth): void;
  onPin(row: SettingsRow, pinned: boolean): void;
  onUnwatch(row: SettingsRow): void;
  onUndo(row: SettingsRow): void;
  onWatch(entry: CatalogEntry): void;
  onLoadMore(): void;
  onRetry(): void;
}

const TONE = { ok: "text-ws-ink3", busy: "text-ws-ink3", error: "text-ws-blocked" } as const;

export function WatchCardView(p: WatchCardViewProps) {
  const selected = p.state.mode === "selected";
  const shown = p.rows.filter((r) => matchesQuery(r, p.query));
  const listed = new Set(p.rows.map((r) => r.container.externalId));
  const found = p.find.entries.filter((e) => !listed.has(e.ref.externalId));
  const watched = p.rows.filter((r) => r.unwatchedAt === null).length;
  const code = p.noun.domain === "code";
  return (
    <article aria-label={`Watching in ${p.title}`} data-domain={p.noun.domain ?? "work"} className="grid gap-3 rounded-xl border border-ws-sep2 bg-ws-win p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="truncate">
            <span className="font-semibold">{p.title}</span> <span className="text-ws-ink3">{p.account}</span>
            {code && <span className="ml-2 rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink2">GitHub</span>}
          </div>
          <div role="status" className={`text-sm [overflow-wrap:anywhere] ${TONE[p.sync.tone]}`}>
            {p.sync.text}
          </div>
        </div>
        <ModeSwitch mode={p.state.mode} noun={p.noun} onChange={p.onMode} />
      </div>
      {p.confirm && <ModeConfirm to={p.confirm} noun={p.noun} onConfirm={p.onConfirm} onCancel={p.onCancelConfirm} />}
      <p className="m-0 text-sm text-ws-ink3">
        {selected
          ? `Watching ${count(watched, p.noun)}. Only these sync, show up and are visible to Pip.${code ? " Gossamr only reads from GitHub; it never comments, merges or pushes." : " You can still open any ticket by its key."}`
          : `Watching every ${p.noun.one} you can see (${watched} synced so far). Switch to selected ${p.noun.many} to keep Gossamr to the ones you use.`}
      </p>
      {selected && <SuggestionChips chips={p.chips} noun={p.noun} onWatch={p.onChip} />}
      <SearchBox value={p.query} label={`Search ${p.noun.many}`} placeholder={code ? `Search ${p.noun.many} by name or owner` : `Search ${p.noun.many} by name or key`} onChange={p.onQuery} />
      <div className="overflow-hidden rounded-[10px] border border-ws-sep">
        <ul aria-label={`Watched ${p.noun.many}`} className="m-0 list-none p-0">
          {shown.map((r) => (
            <SettingsRowView
              key={r.container.externalId}
              row={r}
              noun={p.noun}
              now={p.now}
              pinOnly={!selected}
              onDepth={(d) => p.onDepth(r, d)}
              onPin={(v) => p.onPin(r, v)}
              onUnwatch={() => p.onUnwatch(r)}
              onUndo={() => p.onUndo(r)}
            />
          ))}
          {shown.length === 0 && (
            <li role="status" className="px-3 py-4 text-center text-ws-ink3">
              {p.query.trim() ? `None of the ${p.noun.many} you watch match “${p.query.trim()}”.` : `You aren't watching any ${p.noun.many} yet.`}
            </li>
          )}
        </ul>
      </div>
      {selected && (
        <div className="grid gap-1.5">
          <h3 className="m-0 text-sm font-semibold text-ws-ink2">{p.query.trim() ? `Other ${p.noun.many} matching “${p.query.trim()}”` : `Add ${p.noun.many}`}</h3>
          {p.find.offline && <OfflineNote />}
          <div className="max-h-64 overflow-y-auto rounded-[10px] border border-ws-sep">
            {p.find.status === "error" && p.find.entries.length === 0 ? (
              <CatalogError error={p.find.error} onRetry={p.onRetry} />
            ) : (
              <ul aria-label={`${p.noun.many} you don't watch`} className="m-0 list-none p-0">
                {found.map((e) => (
                  <FindRow key={e.ref.externalId} entry={e} code={code} now={p.now} onWatch={() => p.onWatch(e)} />
                ))}
                {p.find.status === "loading" && found.length === 0 && (
                  <li role="status" className="px-3 py-4 text-center text-ws-ink3">
                    Loading {p.noun.many}…
                  </li>
                )}
                {p.find.status === "ready" && found.length === 0 && !p.find.hasMore && (
                  <li role="status" className="px-3 py-4 text-center text-ws-ink3">
                    {p.query.trim() ? `No other ${p.noun.many} match.` : `You're watching every ${p.noun.one} there is.`}
                  </li>
                )}
                {p.find.hasMore && <ScrollSentinel busy={p.find.loadingMore} onVisible={p.onLoadMore} />}
              </ul>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

const report = (what: string, e: unknown) => useWorkspace.getState().report(what, e);

function WatchCard({ backend, state, connection, syncLine }: { backend: Backend; state: WatchState; connection: ConnectionInfo | undefined; syncLine: SyncLine }) {
  const noun = nounFor(connection?.kind);
  const containers = useWorkspace((s) => s.containers);
  const items = useWorkspace((s) => s.items);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<"everything" | "selected" | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [suggestions, setSuggestions] = useState<Footprint[]>([]);
  const [now, setNow] = useState(() => new Date());
  const selected = state.mode === "selected";
  const find = useCatalog(selected ? backend : null, state.connectionId, query);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selected) return;
    let current = true;
    backend.watchSuggestions(state.connectionId).then(
      (list) => current && setSuggestions(list),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [backend, state.connectionId, selected, state.watches.length]);

  const rows = useMemo(
    () => settingsRows(state, Object.values(containers), (c) => Object.values(items).filter((i) => i.container.externalId === c.externalId).length),
    [state, containers, items],
  );
  const watchedIds = useMemo(() => new Set(rows.filter((r) => r.unwatchedAt === null).map((r) => r.container.externalId)), [rows]);

  const apply = (changes: WatchChange[], what: string) => useWorkspace.getState().watchContainers(state.connectionId, changes).catch((e) => report(what, e));

  const setMode = (mode: "everything" | "selected") =>
    useWorkspace
      .getState()
      .watchMode(state.connectionId, mode)
      .then(() => useToasts.getState().push(`Watching every ${noun.one} you can see.`, "info"))
      .catch((e) => report("Couldn't change what you watch", e));

  return (
    <>
      <WatchCardView
        title={connection?.workspace ?? state.connectionId}
        account={connection?.account ?? ""}
        noun={noun}
        state={state}
        rows={rows}
        query={query}
        now={now}
        sync={connection ? syncLine(connection, now) : { text: "Not connected", tone: "error" }}
        chips={suggestionChips(suggestions, watchedIds)}
        find={find}
        confirm={confirm}
        onQuery={setQuery}
        onMode={setConfirm}
        onConfirm={() => {
          const to = confirm;
          setConfirm(null);
          if (to === "selected") setChoosing(true);
          else if (to === "everything") void setMode("everything");
        }}
        onCancelConfirm={() => setConfirm(null)}
        onChip={(f) => void apply([{ containerId: f.container.externalId, watched: true, source: "footprint" }], `Couldn't watch ${f.name}`)}
        onDepth={(r, depth) => void apply([{ containerId: r.container.externalId, depth }], `Couldn't change ${r.name}`)}
        onPin={(r, pinned) => void apply([{ containerId: r.container.externalId, pinned }], `Couldn't pin ${r.name}`)}
        onUnwatch={(r) => void apply([{ containerId: r.container.externalId, watched: false }], `Couldn't unwatch ${r.name}`)}
        onUndo={(r) => void apply([{ containerId: r.container.externalId, watched: true }], `Couldn't watch ${r.name} again`)}
        onWatch={(e) => void apply([{ containerId: e.ref.externalId, watched: true, source: "manual" }], `Couldn't watch ${e.name}`)}
        onLoadMore={find.loadMore}
        onRetry={find.retry}
      />
      {choosing && (
        <div role="dialog" aria-modal="true" aria-label={`Choose ${noun.many} to watch`} className="fixed inset-0 z-40 bg-ws-win">
          <ChooseWatch backend={backend} state={state} connection={connection} onCancel={() => setChoosing(false)} onDone={() => setChoosing(false)} />
        </div>
      )}
    </>
  );
}

type SyncLine = (c: ConnectionInfo, now: Date) => { text: string; tone: "ok" | "busy" | "error" };

/** One card per connection. */
export function WatchingSection({ syncLine }: { syncLine: SyncLine }) {
  const backend = useBackend();
  const watch = useWorkspace((s) => s.watch);
  const connections = useWorkspace((s) => s.connections);
  if (!backend) return null;
  if (!watch.length) return <p className="m-0 text-ws-ink3">Nothing to watch until a connection is signed in.</p>;
  const card = (w: WatchState) => <WatchCard key={w.connectionId} backend={backend} state={w} connection={connections.find((c) => c.id === w.connectionId)} syncLine={syncLine} />;
  const work = workWatch(watch);
  const code = codeWatch(watch);
  return (
    <div className="grid gap-3">
      {work.map(card)}
      {code.length > 0 && (
        <div className="grid gap-3">
          <p className="m-0 mt-2 text-sm text-ws-ink3">Repositories are read for pull requests, branches and commits that name your tickets. They are not projects and never appear in the project list.</p>
          {code.map(card)}
        </div>
      )}
    </div>
  );
}
