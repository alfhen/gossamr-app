import type { ClearFilter, ClearPreview, DeleteResult, WorktreeInfo } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  Adoptable,
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  Intent,
  ItemRef,
  Person,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  CloneChoice,
  LocalClone,
  Run,
  RunEvent,
  RunQuery,
  RunOutcome,
  RunsChanged,
  AgentSettings,
  CleanupResult,
  Snapshot,
  CodeRef,
  ConnectionInfo,
  DevLink,
  DevLinksChanged,
  DeviceStart,
  GithubSignInOptions,
  WorkComment,
  WorkContainer,
  WorkIdentity,
  WorkMove,
  FeedPage,
  FeedQuery,
  Footprint,
  PullRequestDetail,
  ReviewAccess,
  PullDiff,
  Stray,
  WatchChange,
  WatchChanged,
  WatchState,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workstream,
  WorkstreamEvent,
  WorkstreamUndo,
  WorkstreamView,
  WorkstreamsChanged,
} from "../types";
import { auth, type TokenSignIn } from "./auth";
import { EVENTS, onChanged } from "./events";
import type { Backend, ReadScope } from "./types";

/**
 * Talks to the Rust core, which syncs Jira into a local SQLite cache and emits a `snapshot` event on every change.
 */
export class JiraBackend implements Backend {
  readonly kind = "jira" as const;

  load() {
    return invoke<Snapshot>("snapshot");
  }

  subscribe(listener: (s: Snapshot) => void) {
    const pending = listen<Snapshot>(EVENTS.snapshot, (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  mentionable(key: string, query: string) {
    return invoke<Person[]>("mentionable", { key, query });
  }

  setUnread(id: string, unread: boolean) {
    return invoke<void>("set_unread", { id, unread });
  }

  cacheSearch(filter: WorkFilter, opts: ReadScope = {}) {
    return invoke<WorkItem[]>("cache_search", { filter, includeUnwatched: opts.includeUnwatched ?? false });
  }

  cacheItem(item: ItemRef) {
    return invoke<WorkItem | null>("cache_item", { item, live: false });
  }

  peekItem(item: ItemRef) {
    return invoke<WorkItem | null>("cache_item", { item, live: true });
  }

  cacheContainers(opts: ReadScope = {}) {
    return invoke<WorkContainer[]>("cache_containers", { includeUnwatched: opts.includeUnwatched ?? false });
  }

  cachePeople() {
    return invoke<Person[]>("cache_people");
  }

  cacheMe() {
    return invoke<WorkIdentity>("cache_me");
  }

  cacheComments(item: ItemRef, refresh: boolean) {
    return invoke<WorkComment[]>("cache_comments", { item, refresh });
  }

  cacheTransitions(item: ItemRef) {
    return invoke<WorkMove[]>("cache_transitions", { item });
  }

  connectionsList(refresh = false) {
    return invoke<ConnectionInfo[]>("connections_list", { refresh });
  }

  connectionOpenTerminal(instanceId: string) {
    return invoke<void>("connection_open_terminal", { instanceId });
  }

  connectionRename(instanceId: string, displayName: string) {
    return invoke<void>("connection_rename", { instanceId, displayName });
  }

  githubSignInOptions() {
    return invoke<GithubSignInOptions>("github_sign_in_options");
  }

  githubConnectToken(token: string) {
    return invoke<ConnectionInfo>("github_connect", { source: { via: "token", token } });
  }

  githubImportGhToken() {
    return invoke<ConnectionInfo>("github_connect", { source: { via: "ghCli" } });
  }

  githubDeviceStart() {
    return invoke<DeviceStart>("github_device_start");
  }

  githubDevicePoll() {
    return invoke<ConnectionInfo>("github_connect", { source: { via: "device" } });
  }

  githubDisconnect(connectionId: string) {
    return invoke<void>("github_disconnect", { connectionId });
  }

  devLinks(item: ItemRef) {
    return invoke<DevLink[]>("dev_links", { item, live: false });
  }

  devLinksLive(item: ItemRef) {
    return invoke<DevLink[]>("dev_links", { item, live: true });
  }

  onDevLinksChanged(listener: (change: DevLinksChanged) => void) {
    return onChanged("devLinks", listener);
  }

  codePullRequest(reference: CodeRef) {
    return invoke<PullRequestDetail>("code_pull_request", { reference });
  }

  codePullDiff(connectionId: string, repo: string, number: number) {
    return invoke<PullDiff>("code_pull_diff", { connectionId, repo, number });
  }

  codeReviewAccess(connectionId: string, repo: string) {
    return invoke<ReviewAccess>("code_review_access", { connectionId, repo });
  }

  cacheEvents(item: ItemRef) {
    return invoke<WorkEvent[]>("cache_events", { item });
  }

  cacheFeed(query: FeedQuery) {
    return invoke<FeedPage>("cache_feed", { query });
  }

  cacheFeedUnread(kinds?: FeedQuery["kinds"]) {
    return invoke<number>("cache_feed_unread", { kinds });
  }

  onCacheChanged(listener: (change: CacheChanged) => void) {
    return onChanged("cache", listener);
  }

  proposalsList(query: ProposalQuery = {}) {
    return invoke<Proposal[]>("proposals_list", { query });
  }

  proposalsCreate(intent: Intent, label: string | null = null) {
    return invoke<Proposal>("proposals_create", { intent, label });
  }

  proposalsEdit(id: string, edit: ProposalEdit) {
    return invoke<Proposal>("proposals_edit", { id, edit });
  }

  proposalsSkip(id: string) {
    return invoke<Proposal>("proposals_skip", { id, undo: false });
  }

  proposalsUnskip(id: string) {
    return invoke<Proposal>("proposals_skip", { id, undo: true });
  }

  proposalsApprove(id: string) {
    return invoke<Proposal>("proposals_approve", { id });
  }

  proposalsPostReview(id: string, revisions: number, postAnyway = false) {
    return invoke<Proposal>("proposals_post_review", { id, revisions, postAnyway });
  }

  onProposalsChanged(listener: (change: ProposalsChanged) => void) {
    return onChanged("proposals", listener);
  }

  runsList(query: RunQuery = {}) {
    return invoke<Run[]>("runs_list", { query });
  }

  runsStop(id: string) {
    return invoke<Run>("runs_stop", { id });
  }

  runsAnswer(id: string, text: string) {
    return invoke<Run>("runs_answer", { id, text });
  }

  runsAdoptSession(id: string, session: string) {
    return invoke<Run>("runs_adopt_session", { id, session });
  }

  runsStopAll() {
    return invoke<{ stopped: number; failed: number; waiting: number }>("runs_stop_all");
  }

  runsAttach(id: string) {
    return invoke<void>("runs_open_terminal", { id, purpose: { type: "session" } });
  }

  runsTrustFolder(id: string) {
    return invoke<void>("runs_open_terminal", { id, purpose: { type: "trust" } });
  }

  runsAcceptMode(id: string, mode: "auto" | "bypass") {
    return invoke<void>("runs_open_terminal", { id, purpose: { type: "mode", mode } });
  }

  runsSignIn(id: string) {
    return invoke<void>("runs_open_terminal", { id, purpose: { type: "signIn" } });
  }

  runsClones(repo: string) {
    return invoke<CloneChoice>("runs_clones", { repo });
  }

  runsCloneFresh(repo: string) {
    return invoke<LocalClone>("runs_clone_fresh", { repo });
  }

  runsPickClone(repo: string, path: string) {
    return invoke<void>("runs_pick_clone", { repo, path });
  }

  runsOutcome(id: string) {
    return invoke<RunOutcome>("runs_outcome", { id });
  }

  runsEvents(id: string) {
    return invoke<RunEvent[]>("runs_events", { id });
  }

  runsStartNow(id: string) {
    return invoke<Run>("runs_start", { id, retry: false });
  }

  runsKeepRunning() {
    return invoke<number>("runs_keep_running");
  }

  revealPath(path: string) {
    return revealItemInDir(path);
  }

  runsDisk(id: string) {
    return invoke<number>("runs_disk", { id });
  }

  runsSettings() {
    return invoke<AgentSettings>("agent_settings", { settings: null });
  }

  reduceTransparency() {
    return invoke<boolean>("reduce_transparency");
  }

  onConnectionsChanged(listener: () => void) {
    return onChanged("connections", () => listener());
  }

  onDisplayChanged(listener: () => void) {
    return onChanged("display", () => listener());
  }

  setNeedsBadge(count: number) {
    return invoke<void>("set_needs_badge", { count });
  }

  runsSetSettings(settings: AgentSettings) {
    return invoke<AgentSettings>("agent_settings", { settings });
  }

  runsCleanup(id: string) {
    return invoke<CleanupResult>("runs_cleanup", { id });
  }

  runsArchive(ids: string[]) {
    return invoke<string[]>("runs_archive", { ids, restore: false });
  }

  runsRestore(id: string) {
    return invoke<string[]>("runs_archive", { ids: [id], restore: true }).then(() => {});
  }

  runsClearPreview(filter: ClearFilter) {
    return invoke<ClearPreview>("runs_clear_preview", { filter });
  }

  runsClear(filter: ClearFilter) {
    return invoke<string[]>("runs_clear", { filter });
  }

  runsWorktreeInfo(id: string) {
    return invoke<WorktreeInfo>("runs_worktree_info", { id });
  }

  runsDelete(id: string, removeWorktree: boolean) {
    return invoke<DeleteResult>("runs_delete", { id, removeWorktree });
  }

  runsRetryLaunch(id: string) {
    return invoke<Run>("runs_start", { id, retry: true });
  }

  onRunsChanged(listener: (change: RunsChanged) => void) {
    return onChanged("runs", listener);
  }

  onOpenRun(listener: (runId: string) => void) {
    const pending = listen<{ runId: string }>(EVENTS.openRun, (e) => listener(e.payload.runId));
    return () => void pending.then((unlisten) => unlisten());
  }

  workstreamsOpen(item: ItemRef | null, title?: string) {
    return invoke<Workstream>("workstreams_open", { item, title: title ?? null });
  }

  workstreamsList(includeClosed = false) {
    return invoke<WorkstreamView[]>("workstreams_list", { includeClosed });
  }

  workstreamsClose(id: string) {
    return invoke<Workstream>("workstreams_set_state", { id, state: "close" });
  }
  workstreamsReopen(id: string) {
    return invoke<Workstream>("workstreams_set_state", { id, state: "reopen" });
  }
  workstreamsAdopt(id: string) {
    return invoke<Adoptable>("workstreams_adopt", { id });
  }

  workstreamsEvents(id: string) {
    return invoke<WorkstreamEvent[]>("workstreams_events", { id });
  }

  workstreamsPause(id: string) {
    return invoke<Workstream>("workstreams_set_state", { id, state: "pause" });
  }

  workstreamsResume(id: string) {
    return invoke<Workstream>("workstreams_set_state", { id, state: "resume" });
  }

  workstreamsDismissAsk(id: string) {
    return invoke<boolean>("workstreams_dismiss_ask", { id });
  }

  workstreamsUndo(id: string, undo: WorkstreamUndo) {
    return invoke<Workstream>("workstreams_undo", { id, undo });
  }

  workstreamsStop(id: string) {
    return invoke<{ stopped: number; failed: number }>("workstreams_stop", { id });
  }

  onWorkstreamsChanged(listener: (change: WorkstreamsChanged) => void) {
    return onChanged("workstreams", listener);
  }

  watchGet() {
    return invoke<WatchState[]>("watch_get");
  }

  watchSetContainers(connectionId: string, changes: WatchChange[]) {
    return invoke<void>("watch_set", { connectionId, changes });
  }

  watchCatalog(connectionId: string, query: string, cursor: string | null = null) {
    return invoke<CatalogPage>("watch_catalog", { connectionId, query, cursor });
  }

  watchSuggestions(connectionId: string, refresh = false) {
    return invoke<Footprint[]>("watch_suggestions", { connectionId, refresh });
  }

  watchUnwatchedAssigned(connectionId: string, refresh = false) {
    return invoke<Stray[]>("watch_unwatched_assigned", { connectionId, refresh });
  }

  watchDismissAssigned(connectionId: string, containerId: string) {
    return invoke<void>("watch_dismiss_assigned", { connectionId, containerId });
  }

  onWatchChanged(listener: (change: WatchChanged) => void) {
    return onChanged("watch", listener);
  }

  onAssignedElsewhere(listener: (found: AssignedElsewhere) => void) {
    return onChanged("assignedElsewhere", ({ connectionId, strays }) => listener({ connectionId, strays: strays ?? [] }));
  }

  syncNow() {
    return invoke<void>("sync_now");
  }

  jiraStatus() {
    return auth.status();
  }

  jiraCloudId(site: string) {
    return auth.cloudId(site);
  }

  jiraConnect(input: TokenSignIn) {
    return auth.connect(input);
  }

  openUrl(url: string) {
    return openUrl(url);
  }
}
