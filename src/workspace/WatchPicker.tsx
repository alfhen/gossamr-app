import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Backend } from "../backend/types";
import type { CatalogEntry, ConnectionInfo, Footprint, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { keyColour, keyInitials } from "./projects";
import { useCatalog, type Catalog } from "./useCatalog";
import { messageOf, useToasts } from "./toasts";
import { activityHint, agoText, choiceChanges, count, nounFor, permissionLabel, repoParts, suggestedIds, toggled, type Noun } from "./watchLogic";

export function Badge({ k }: { k: string }) {
  return (
    <span aria-hidden style={{ background: keyColour(k) }} className="grid size-6 shrink-0 place-items-center rounded-[7px] text-[10px] font-bold text-white">
      {keyInitials(k)}
    </span>
  );
}

/** A repository as `owner/name`, the owner quiet so the name is what is read. */
export function RepoName({ k }: { k: string }) {
  const { owner, name } = repoParts(k);
  return (
    <>
      {owner && <span className="text-ws-ink3">{owner}/</span>}
      <span className="font-semibold text-ws-ink">{name}</span>
    </>
  );
}

const PERMISSION_TITLE: Record<string, string> = {
  admin: "You administer this repository",
  maintain: "You can manage it without admin rights",
  push: "You can push to it",
  triage: "You can triage issues and pull requests",
  pull: "You can read it",
};

export function PermissionBadge({ kind }: { kind: string | null }) {
  const label = permissionLabel(kind);
  if (!label) return null;
  return (
    <span title={PERMISSION_TITLE[kind ?? ""]} className="shrink-0 rounded-full border border-ws-sep2 px-1.5 text-xs text-ws-ink2">
      {label}
    </span>
  );
}

export function ArchivedBadge() {
  return (
    <span title="Archived repositories are read-only on GitHub" className="shrink-0 rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink3">
      archived
    </span>
  );
}

/** What the catalog knows about a repository beyond its name. */
export interface RepoMeta {
  permission: string | null;
  archived: boolean;
  lastActive: string | null;
}

export interface PickerRowProps {
  k: string;
  name: string;
  checked: boolean;
  /** Items the tracker says the container holds, when it says. */
  itemHint: number | null;
  footprint?: Footprint;
  /** Set for a repository, which is listed by owner and name with its permission and last push. */
  repo?: RepoMeta;
  now?: Date;
  onToggle(): void;
}

export function PickerRow({ k, name, checked, itemHint, footprint, repo, now = new Date(), onToggle }: PickerRowProps) {
  const hint = footprint ? activityHint(footprint) : null;
  return (
    <li className="border-b border-ws-sep last:border-b-0">
      <label className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-ws-hover ${checked ? "" : "text-ws-ink2"} ${repo?.archived ? "opacity-60" : ""}`}>
        <input type="checkbox" checked={checked} onChange={onToggle} className="size-4 shrink-0 accent-ws-accent" />
        <Badge k={repo ? repoParts(k).name : k} />
        {repo ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              <RepoName k={k} />
            </span>
            {repo.archived && <ArchivedBadge />}
            <PermissionBadge kind={repo.permission} />
            {repo.lastActive && (
              <span className="hidden w-24 shrink-0 text-right text-sm text-ws-ink3 sm:block" title={`Last push ${new Date(repo.lastActive).toLocaleString()}`}>
                pushed {agoText(repo.lastActive, now)}
              </span>
            )}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-ws-ink">{name}</span>
            <span className="ml-1.5 text-sm text-ws-ink3">{k}</span>
          </span>
        )}
        {hint && <span className="hidden shrink-0 truncate text-sm text-ws-pip sm:block">{hint}</span>}
        {itemHint !== null && <span className="w-16 shrink-0 text-right text-sm text-ws-ink3">{itemHint} items</span>}
      </label>
    </li>
  );
}

export function GroupHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <li role="presentation" className="flex justify-between border-b border-ws-sep bg-ws-bar px-3 py-1 text-xs font-semibold text-ws-ink3">
      <span>{children}</span>
      {right && <span className="font-normal">{right}</span>}
    </li>
  );
}

/** Loads the next page when it scrolls into view; the button is for where that can't happen. */
export function ScrollSentinel({ busy, onVisible }: { busy: boolean; onVisible(): void }) {
  const el = useRef<HTMLLIElement>(null);
  const seen = useRef(onVisible);
  seen.current = onVisible;
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((hits) => hits.some((h) => h.isIntersecting) && seen.current());
    io.observe(node);
    return () => io.disconnect();
  }, [busy]);
  return (
    <li ref={el} role="presentation" className="grid place-items-center py-2">
      <button type="button" disabled={busy} onClick={onVisible} className="rounded-md px-3 py-1 text-sm text-ws-ink2 hover:bg-ws-hover disabled:opacity-60">
        {busy ? "Loading more…" : "Load more"}
      </button>
    </li>
  );
}

export function SearchBox({ value, label, placeholder, onChange }: { value: string; label: string; placeholder: string; onChange(q: string): void }) {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(ev) => onChange(ev.target.value)}
      className="w-full rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 outline-none placeholder:text-ws-ink3 focus:border-ws-accent"
    />
  );
}

export function OfflineNote() {
  return (
    <p role="status" className="m-0 rounded-md border border-ws-sep2 bg-ws-bar px-3 py-1.5 text-sm text-ws-ink2">
      You're offline. This is what was listed last time, so some may be missing.
    </p>
  );
}

export function CatalogError({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <div role="alert" className="grid justify-items-center gap-2 px-4 py-8 text-center text-ws-blocked">
      <p className="m-0 [overflow-wrap:anywhere]">{error ?? "Couldn't load the list."}</p>
      <button type="button" onClick={onRetry} className="rounded-md border border-ws-sep2 px-3 py-1 text-ws-ink hover:bg-ws-hover">
        Try again
      </button>
    </div>
  );
}

export interface WatchPickerViewProps {
  noun: Noun;
  workspace: string;
  query: string;
  suggested: { status: "loading" | "ready" | "error"; list: Footprint[] };
  catalog: Pick<Catalog, "entries" | "status" | "error" | "offline" | "hasMore" | "loadingMore">;
  selected: ReadonlySet<string>;
  saving: boolean;
  saveError: string | null;
  now?: Date;
  onQuery(q: string): void;
  onToggle(id: string): void;
  onSelectNone(): void;
  onSelectSuggested(): void;
  onLoadMore(): void;
  onRetry(): void;
  onSave(): void;
  onEverything(): void;
  /** Present only where the picker can be left without choosing, such as when switching modes in Settings. */
  onCancel?(): void;
}

export function WatchPickerView(p: WatchPickerViewProps) {
  const { noun, catalog, selected } = p;
  const searching = p.query.trim() !== "";
  const fp = new Map(p.suggested.list.map((f) => [f.container.externalId, f]));
  const suggested = searching ? [] : p.suggested.list;
  const rows: CatalogEntry[] = searching ? catalog.entries : catalog.entries.filter((e) => !fp.has(e.ref.externalId));
  const n = selected.size;
  const code = noun.domain === "code";
  const row = (id: string, k: string, name: string, itemHint: number | null, entry?: CatalogEntry) => (
    <PickerRow
      key={id}
      k={k}
      name={name}
      checked={selected.has(id)}
      itemHint={itemHint}
      footprint={fp.get(id)}
      repo={code ? { permission: entry?.kind ?? null, archived: entry?.archived ?? false, lastActive: entry?.lastActive ?? null } : undefined}
      now={p.now}
      onToggle={() => p.onToggle(id)}
    />
  );
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[780px] flex-col px-8 pt-12 pb-6">
      <h1 className="m-0 text-2xl font-bold">Choose what to watch</h1>
      <p className="mt-1 mb-4 max-w-[620px] text-ws-ink2">
        Gossamr only syncs, shows and lets Pip read the {noun.many} you watch in {p.workspace}. {code ? "Anything else isn't read at all." : "Anything else is one search away and is never stored."} You can change this any time in Settings.
      </p>
      <SearchBox value={p.query} label={`Search ${noun.many}`} placeholder={code ? `Search ${noun.many} by name or owner` : `Search ${noun.many} by name or key`} onChange={p.onQuery} />
      <div className="my-2.5 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={p.onSelectNone} disabled={n === 0} className="rounded-full border border-ws-sep2 px-2.5 py-px text-sm text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
          Select none
        </button>
        <button type="button" onClick={p.onSelectSuggested} disabled={!p.suggested.list.length} className="rounded-full border border-ws-sep2 px-2.5 py-px text-sm text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
          Select suggested
        </button>
        {catalog.offline && <OfflineNote />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[10px] border border-ws-sep">
        {catalog.status === "error" && catalog.entries.length === 0 ? (
          <CatalogError error={catalog.error} onRetry={p.onRetry} />
        ) : (
          <ul aria-label={`Available ${noun.many}`} className="m-0 list-none p-0">
            {!searching && p.suggested.status === "loading" && <GroupHeading>Looking at where you've worked in the last 90 days…</GroupHeading>}
            {!searching && p.suggested.status === "error" && <GroupHeading>Suggestions aren't available right now</GroupHeading>}
            {suggested.length > 0 && <GroupHeading right="your last 90 days">Suggested for you</GroupHeading>}
            {suggested.map((f) => row(f.container.externalId, f.key, f.name, null, catalog.entries.find((e) => e.ref.externalId === f.container.externalId)))}
            {(suggested.length > 0 || searching) && rows.length > 0 && <GroupHeading>{searching ? `Matching “${p.query.trim()}”` : `All ${noun.many}`}</GroupHeading>}
            {catalog.status === "loading" && catalog.entries.length === 0 && (
              <li role="status" className="px-3 py-6 text-center text-ws-ink3">
                Loading {noun.many}…
              </li>
            )}
            {rows.map((e) => row(e.ref.externalId, e.key, e.name, e.itemHint, e))}
            {catalog.status === "ready" && rows.length === 0 && suggested.length === 0 && (
              <li role="status" className="px-3 py-6 text-center text-ws-ink3">
                {searching ? `No ${noun.many} match “${p.query.trim()}”.` : `There are no ${noun.many} to watch.`}
              </li>
            )}
            {catalog.hasMore && <ScrollSentinel busy={catalog.loadingMore} onVisible={p.onLoadMore} />}
          </ul>
        )}
      </div>
      {p.saveError && (
        <p role="alert" className="mt-2 mb-0 text-ws-blocked [overflow-wrap:anywhere]">
          {p.saveError}
        </p>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <span role="status" className="flex-1 text-ws-ink2">
          {n} selected
        </span>
        {p.onCancel && (
          <button type="button" onClick={p.onCancel} disabled={p.saving} className="rounded-lg px-3 py-1.5 text-ws-ink2 hover:bg-ws-hover">
            Cancel
          </button>
        )}
        <button type="button" onClick={p.onSave} disabled={n === 0 || p.saving} className="rounded-lg bg-ws-accent px-4 py-1.5 font-semibold text-white disabled:opacity-45">
          {p.saving ? "Saving…" : "Start watching"}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ws-sep pt-3">
        <p className="m-0 min-w-0 flex-1 text-sm text-ws-ink3">
          Prefer not to choose? Watching everything syncs every {noun.one} you can see, so the first sync is slower, {code ? `pull requests from ${noun.many} you never use show up` : `tickets from ${noun.many} you never use show up`}, and Pip can read all of it.
        </p>
        <button type="button" onClick={p.onEverything} disabled={p.saving} className="shrink-0 rounded-lg border border-ws-sep2 px-3 py-1.5 font-semibold hover:bg-ws-hover disabled:opacity-45">
          Watch everything
        </button>
      </div>
    </div>
  );
}

export interface ChooseWatchProps {
  backend: Backend;
  state: WatchState;
  connection?: Pick<ConnectionInfo, "kind" | "workspace">;
  /** Leaves the picker without choosing; absent when a choice is required. */
  onCancel?(): void;
  /** Called after the choice was saved. */
  onDone?(): void;
}

export function ChooseWatch({ backend, state, connection, onCancel, onDone }: ChooseWatchProps) {
  const noun = nounFor(connection?.kind);
  const [query, setQuery] = useState("");
  const catalog = useCatalog(backend, state.connectionId, query);
  const [suggested, setSuggested] = useState<WatchStateSuggested>({ status: "loading", list: [] });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const touched = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setSuggested((s) => ({ ...s, status: "loading" }));
    backend.watchSuggestions(state.connectionId, attempt > 0).then(
      (list) => {
        if (!current) return;
        setSuggested({ status: "ready", list });
        if (!touched.current) setSelected(suggestedIds(list));
      },
      () => current && setSuggested({ status: "error", list: [] }),
    );
    return () => {
      current = false;
    };
  }, [backend, state.connectionId, attempt]);

  const change = (next: ReadonlySet<string>) => {
    touched.current = true;
    setSelected(next);
  };

  const run = async (job: () => Promise<void>, done: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await job();
      useToasts.getState().push(done, "info");
      onDone?.();
    } catch (e) {
      setSaveError(messageOf(e));
      setSaving(false);
    }
  };

  return (
    <WatchPickerView
      noun={noun}
      workspace={connection?.workspace ?? state.connectionId}
      query={query}
      suggested={suggested}
      catalog={catalog}
      selected={selected}
      saving={saving}
      saveError={saveError}
      onQuery={setQuery}
      onToggle={(id) => change(toggled(selected, id))}
      onSelectNone={() => change(new Set())}
      onSelectSuggested={() => change(suggestedIds(suggested.list))}
      onLoadMore={catalog.loadMore}
      onRetry={() => (catalog.retry(), setAttempt((n) => n + 1))}
      onSave={() =>
        void run(
          () => useWorkspace.getState().chooseWatch(state.connectionId, choiceChanges(selected, suggested.list)),
          `Watching ${count(selected.size, noun)}. You can change this any time in Settings.`,
        )
      }
      onEverything={() => void run(() => useWorkspace.getState().watchMode(state.connectionId, "everything"), `Watching every ${noun.one} you can see.`)}
      onCancel={onCancel}
    />
  );
}

interface WatchStateSuggested {
  status: "loading" | "ready" | "error";
  list: Footprint[];
}
