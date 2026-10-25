import type { ClearFilter, ClearPreview, DeleteResult, WorktreeInfo } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ClarityGap } from "../lib/ticketClarity";
import type {
  Adoptable,
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  ContainerRef,
  Intent,
  ItemRef,
  Person,
  PlanComment,
  Preflight,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  CloneChoice,
  LocalClone,
  Run,
  RunEvent,
  RunQuery,
  RunReview,
  RunSpec,
  RunOutcome,
  RunsChanged,
  RunsEnabledChange,
  AgentSettings,
  CleanupResult,
  Snapshot,
  CodeChange,
  CodeCommitQuery,
  CodeFile,
  CodeHit,
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
  ChangedFile,
  PullDiff,
  Stray,
  TreeEntry,
  WatchChange,
  WatchChanged,
  WatchMode,
  WatchState,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workstream,
  WorkstreamEvent,
  WorkstreamMode,
  WorkstreamUndo,
  WorkstreamRule,
  WorkstreamView,
  WorkstreamsChanged,
} from "../types";
import { readEnvironment } from "./runsEnvironment";
import type { Backend, ReadScope } from "./types";

/** The Jira site and account this backend acts for. */
export interface Scope {
  cloudId: string;
  accountId: string;
}

/**
 * Talks to the Rust core, which syncs Jira into a local SQLite cache and emits a `snapshot` event on every change.
 * Writes carry `scope`, so a write started for one account is refused if someone else has signed in meanwhile.
 */
export class JiraBackend implements Backend {
  readonly kind = "jira" as const;

  constructor(private readonly scope: Scope) {}

  load() {
    return invoke<Snapshot>("snapshot");
  }

  subscribe(listener: (s: Snapshot) => void) {
    const pending = listen<Snapshot>("snapshot", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  mentionable(key: string, query: string) {
    return invoke<Person[]>("mentionable", { key, query });
  }

  createSubtasks(key: string, summaries: string[]) {
    return invoke<{ created: string[]; error: string | null }>("create_subtasks", { scope: this.scope, key, summaries });
  }

  setUnread(id: string, unread: boolean) {
    return invoke<void>("set_unread", { id, unread });
  }

  cacheSearch(filter: WorkFilter, opts: ReadScope = {}) {
    return invoke<WorkItem[]>("cache_search", { filter, includeUnwatched: opts.includeUnwatched ?? false });
  }

  cacheItem(item: ItemRef) {
    return invoke<WorkItem | null>("cache_item", { item });
  }

  peekItem(item: ItemRef) {
    return invoke<WorkItem | null>("peek_item", { item });
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

  connectionsList() {
    return invoke<ConnectionInfo[]>("connections_list");
  }

  githubSignInOptions() {
    return invoke<GithubSignInOptions>("github_sign_in_options");
  }

  githubConnectToken(token: string) {
    return invoke<ConnectionInfo>("github_connect_token", { token });
  }

  githubImportGhToken() {
    return invoke<ConnectionInfo>("github_import_gh_token");
  }

  githubDeviceStart() {
    return invoke<DeviceStart>("github_device_start");
  }

  githubDevicePoll() {
    return invoke<ConnectionInfo>("github_device_poll");
  }

  githubDisconnect(connectionId: string) {
    return invoke<void>("github_disconnect", { connectionId });
  }

  devLinks(item: ItemRef) {
    return invoke<DevLink[]>("dev_links", { item });
  }

  devLinksLive(item: ItemRef) {
    return invoke<DevLink[]>("dev_links_live", { item });
  }

  onDevLinksChanged(listener: (change: DevLinksChanged) => void) {
    const pending = listen<DevLinksChanged>("dev-links-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  codePullRequest(reference: CodeRef) {
    return invoke<PullRequestDetail>("code_pull_request", { reference });
  }

  codePullFiles(connectionId: string, repo: string, number: number) {
    return invoke<ChangedFile[]>("code_pull_files", { connectionId, repo, number });
  }

  codePullDiff(connectionId: string, repo: string, number: number) {
    return invoke<PullDiff>("code_pull_diff", { connectionId, repo, number });
  }

  codeReviewAccess(connectionId: string, repo: string) {
    return invoke<ReviewAccess>("code_review_access", { connectionId, repo });
  }

  codeSearch(query: string) {
    return invoke<CodeChange[]>("code_search", { query });
  }

  codeEvents(limit?: number) {
    return invoke<WorkEvent[]>("code_events", { limit });
  }

  codeFile(connectionId: string, repo: string, path: string, reference: string | null = null) {
    return invoke<CodeFile>("code_file", { connectionId, repo, path, reference });
  }

  codeTree(connectionId: string, repo: string, path: string, reference: string | null = null) {
    return invoke<TreeEntry[]>("code_tree", { connectionId, repo, path, reference });
  }

  codeCommits(connectionId: string, repo: string, opts: CodeCommitQuery = {}) {
    return invoke<CodeChange[]>("code_commits", { connectionId, repo, reference: opts.reference ?? null, since: opts.since ?? null, query: opts.query ?? null, limit: opts.limit });
  }

  codeSearchCode(connectionId: string, query: string, repos?: string[]) {
    return invoke<CodeHit[]>("code_search_code", { connectionId, query, repos });
  }

  cacheEvents(item: ItemRef) {
    return invoke<WorkEvent[]>("cache_events", { item });
  }

  cacheFeed(query: FeedQuery) {
    return invoke<FeedPage>("cache_feed", { query });
  }

  cacheFeedUnread() {
    return invoke<number>("cache_feed_unread");
  }

  onCacheChanged(listener: (change: CacheChanged) => void) {
    const pending = listen<CacheChanged>("cache-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  proposalsList(query: ProposalQuery = {}) {
    return invoke<Proposal[]>("proposals_list", { query });
  }

  proposalsGet(id: string) {
    return invoke<Proposal | null>("proposals_get", { id });
  }

  proposalsCreate(intent: Intent, label: string | null = null) {
    return invoke<Proposal>("proposals_create", { intent, label });
  }

  proposalsEdit(id: string, edit: ProposalEdit) {
    return invoke<Proposal>("proposals_edit", { id, edit });
  }

  proposalsSkip(id: string) {
    return invoke<Proposal>("proposals_skip", { id });
  }

  proposalsUnskip(id: string) {
    return invoke<Proposal>("proposals_unskip", { id });
  }

  proposalsApprove(id: string) {
    return invoke<Proposal>("proposals_approve", { id });
  }

  proposalsPostReview(id: string, revisions: number, postAnyway = false) {
    return invoke<Proposal>("proposals_post_review", { id, revisions, postAnyway });
  }

  onProposalsChanged(listener: (change: ProposalsChanged) => void) {
    const pending = listen<ProposalsChanged>("proposals-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  runsEnabled() {
    return invoke<boolean>("runs_enabled");
  }

  runsSetEnabled(enabled: boolean) {
    return invoke<RunsEnabledChange>("runs_set_enabled", { enabled });
  }

  runsList(query: RunQuery = {}) {
    return invoke<Run[]>("runs_list", { query });
  }

  runsGet(id: string) {
    return invoke<Run | null>("runs_get", { id });
  }

  runsReview(proposalId: string) {
    return invoke<RunReview>("runs_review", { proposalId });
  }

  runsApprove(proposalId: string, digest: string) {
    return invoke<Run>("runs_approve", { proposalId, digest });
  }

  runsStop(id: string) {
    return invoke<Run>("runs_stop", { id });
  }

  runsAnswer(id: string, text: string) {
    return invoke<Run>("runs_answer", { id, text });
  }

  runsDenyPermission(id: string, command: string) {
    return invoke<Run>("runs_deny_permission", { id, command });
  }

  runsAllowPermissionOnce(id: string, command: string) {
    return invoke<Run>("runs_allow_permission_once", { id, command });
  }

  runsSendFollowUp(proposalId: string, message: string) {
    return invoke<Run>("runs_send_follow_up", { proposalId, message });
  }

  runsAnswerDraft(proposalId: string, message: string) {
    return invoke<Run>("runs_answer_draft", { proposalId, message });
  }

  runsAdoptSession(id: string, session: string) {
    return invoke<Run>("runs_adopt_session", { id, session });
  }

  runsStopAll() {
    return invoke<{ stopped: number; failed: number; waiting: number }>("runs_stop_all");
  }

  runsAttach(id: string) {
    return invoke<void>("runs_attach", { id });
  }

  runsTrustFolder(id: string) {
    return invoke<void>("runs_trust_folder", { id });
  }

  runsTrustPath(path: string) {
    return invoke<void>("runs_trust_path", { path });
  }

  runsSignIn(id: string) {
    return invoke<void>("runs_sign_in", { id });
  }

  runsPreflight(spec: RunSpec | null) {
    return invoke<Preflight>("runs_preflight", { spec });
  }

  runsDraft(spec: RunSpec, item: ItemRef | null) {
    return invoke<Proposal>("runs_draft", { spec, item });
  }

  runsRepos() {
    return invoke<string[]>("runs_repos");
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

  runsSuggestName(clonePath: string, key: string, title: string) {
    return invoke<string>("runs_suggest_name", { clonePath, key, title });
  }

  runsOutcome(id: string) {
    return invoke<RunOutcome>("runs_outcome", { id });
  }

  runsDraftComment(id: string) {
    return invoke<Proposal>("runs_draft_comment", { id });
  }

  runsDraftPlanDescription(id: string) {
    return invoke<Proposal>("runs_draft_plan_description", { id });
  }

  runsDraftPlanComment(id: string) {
    return invoke<PlanComment>("runs_draft_plan_comment", { id });
  }

  runsRefreshPlan(id: string) {
    return invoke<Proposal>("runs_refresh_plan", { id });
  }

  runsRefreshBuildAccount(id: string) {
    return invoke<Proposal>("runs_refresh_build_account", { id });
  }

  runsDraftTicket(id: string) {
    return invoke<Proposal>("runs_draft_ticket", { id });
  }

  runsRepoProject(repo: string) {
    return invoke<ContainerRef | null>("runs_repo_project", { repo });
  }

  runsDraftBlocker(id: string, blockerKey: string) {
    return invoke<Proposal>("runs_draft_blocker", { id, blockerKey });
  }

  runsEvents(id: string) {
    return invoke<RunEvent[]>("runs_events", { id });
  }

  runsStartNow(id: string) {
    return invoke<Run>("runs_start_now", { id });
  }

  runsKeepRunning() {
    return invoke<number>("runs_keep_running");
  }

  revealPath(path: string) {
    return revealItemInDir(path);
  }

  runsEnvironment() {
    return readEnvironment(() => this.runsPreflight(null));
  }

  runsDisk(id: string) {
    return invoke<number>("runs_disk", { id });
  }

  runsSettings() {
    return invoke<AgentSettings>("runs_settings");
  }

  runsSetSettings(settings: AgentSettings) {
    return invoke<AgentSettings>("runs_set_settings", { settings });
  }

  runsCleanup(id: string) {
    return invoke<CleanupResult>("runs_cleanup", { id });
  }

  runsArchive(ids: string[]) {
    return invoke<string[]>("runs_archive", { ids });
  }

  runsRestore(id: string) {
    return invoke<void>("runs_restore", { id });
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
    return invoke<Run>("runs_retry_launch", { id });
  }

  onRunsChanged(listener: (change: RunsChanged) => void) {
    const pending = listen<RunsChanged>("runs-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  onOpenRun(listener: (runId: string) => void) {
    const pending = listen<{ runId: string }>("open-run", (e) => listener(e.payload.runId));
    return () => void pending.then((unlisten) => unlisten());
  }

  workstreamsOpen(item: ItemRef | null, title?: string) {
    return invoke<Workstream>("workstreams_open", { item, title: title ?? null });
  }

  workstreamsGet(id: string) {
    return invoke<WorkstreamView | null>("workstreams_get", { id });
  }

  workstreamsList(includeClosed = false) {
    return invoke<WorkstreamView[]>("workstreams_list", { includeClosed });
  }

  workstreamsClose(id: string) {
    return invoke<Workstream>("workstreams_close", { id });
  }
  workstreamsReopen(id: string) {
    return invoke<Workstream>("workstreams_reopen", { id });
  }
  workstreamsAdopt(id: string) {
    return invoke<Adoptable>("workstreams_adopt", { id });
  }

  workstreamsSetNotes(id: string, notes: string) {
    return invoke<Workstream>("workstreams_set_notes", { id, notes });
  }

  workstreamsEvents(id: string) {
    return invoke<WorkstreamEvent[]>("workstreams_events", { id });
  }

  workstreamsSetMode(id: string, mode: WorkstreamMode) {
    return invoke<Workstream>("workstreams_set_mode", { id, mode });
  }

  workstreamsFixRound(reviewRun: string) {
    return invoke<Run>("workstreams_fix_round", { reviewRun });
  }

  workstreamsTakeOver(id: string, reviewRun: string) {
    return invoke<Workstream>("workstreams_take_over", { id, reviewRun });
  }

  workstreamsReadinessAsk(id: string, triageRun: string) {
    return invoke<Proposal>("workstreams_readiness_ask", { id, triageRun });
  }

  workstreamsClarityAsk(id: string, skip: ClarityGap[] = []) {
    return invoke<Proposal>("workstreams_clarity_ask", { id, skip });
  }

  workstreamsClarityDismiss(id: string) {
    return invoke<Workstream>("workstreams_clarity_dismiss", { id });
  }

  workstreamsNudgeReporter(id: string) {
    return invoke<Proposal>("workstreams_nudge_reporter", { id });
  }

  workstreamsClarityNote(id: string, action: "clarity_learned" | "clarity_reset", detail: string) {
    return invoke<void>("workstreams_clarity_note", { id, action, detail });
  }

  workstreamsReadinessAnswer(id: string, triageRun: string) {
    return invoke<Workstream>("workstreams_readiness_answer", { id, triageRun });
  }

  workstreamsReadinessOverride(id: string, triageRun: string) {
    return invoke<Workstream>("workstreams_readiness_override", { id, triageRun });
  }

  workstreamsHold(id: string) {
    return invoke<Workstream>("workstreams_hold", { id });
  }

  workstreamsResume(id: string) {
    return invoke<Workstream>("workstreams_resume", { id });
  }

  workstreamsAllowMore(id: string) {
    return invoke<Workstream>("workstreams_allow_more", { id });
  }

  workstreamsUndo(id: string, undo: WorkstreamUndo) {
    return invoke<Workstream>("workstreams_undo", { id, undo });
  }

  workstreamsSetRule(id: string, rule: WorkstreamRule, on: boolean | null) {
    return invoke<Workstream>("workstreams_set_rule", { id, rule, on });
  }

  workstreamsHoldAll() {
    return invoke<Workstream[]>("workstreams_hold_all");
  }

  workstreamsStop(id: string) {
    return invoke<{ stopped: number; failed: number }>("workstreams_stop", { id });
  }

  onWorkstreamsChanged(listener: (change: WorkstreamsChanged) => void) {
    const pending = listen<WorkstreamsChanged>("workstreams-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  watchGet() {
    return invoke<WatchState[]>("watch_get");
  }

  watchSetMode(connectionId: string, mode: WatchMode) {
    return invoke<void>("watch_set_mode", { connectionId, mode });
  }

  watchSetContainers(connectionId: string, changes: WatchChange[]) {
    return invoke<void>("watch_set_containers", { connectionId, changes });
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
    const pending = listen<WatchChanged>("watch-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  onAssignedElsewhere(listener: (found: AssignedElsewhere) => void) {
    const pending = listen<AssignedElsewhere>("watch-assigned-elsewhere", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  async reconnectJira() {
    await invoke("sign_in");
  }

  syncNow() {
    return invoke<void>("sync_now");
  }

  openUrl(url: string) {
    return openUrl(url);
  }
}
