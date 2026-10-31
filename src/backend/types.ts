import type { AuthStatus, TokenSignIn } from "./auth";
import type { ClearFilter, ClearPreview, DeleteResult, WorktreeInfo } from "../types";
import type {
  Adoptable,
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  CloneChoice,
  LocalClone,
  Intent,
  ItemRef,
  Person,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  Run,
  RunEvent,
  RunQuery,
  RunOutcome,
  RunsChanged,
  AgentSettings,
  CleanupResult,
  Snapshot,
  PullDiff,
  CodeRef,
  ConnectionInfo,
  DevLink,
  DevLinksChanged,
  DeviceStart,
  FeedPage,
  FeedQuery,
  Footprint,
  GithubSignInOptions,
  PullRequestDetail,
  ReviewAccess,
  Stray,
  WatchChange,
  WatchChanged,
  WatchState,
  WorkComment,
  WorkContainer,
  WorkIdentity,
  WorkMove,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workstream,
  WorkstreamEvent,
  WorkstreamUndo,
  WorkstreamView,
  WorkstreamsChanged,
} from "../types";

/** Reads are limited to watched containers; this lifts that for views that must reach everything, like jumping to a key. */
export interface ReadScope {
  includeUnwatched?: boolean;
}

export interface Backend {
  readonly kind: "mock" | "jira";
  load(): Promise<Snapshot>;
  /** Called with a fresh snapshot whenever local or remote state changes. Returns an unsubscribe function. */
  subscribe(listener: (snap: Snapshot) => void): () => void;
  /** People who can see the ticket and match the query, for @mention suggestions. */
  mentionable(ticketKey: string, query: string): Promise<Person[]>;
  setUnread(eventId: string, unread: boolean): Promise<void>;
  /** Items in the local cache that match the filter, newest first. Works offline. Only watched containers unless `includeUnwatched`. */
  cacheSearch(filter: WorkFilter, opts?: ReadScope): Promise<WorkItem[]>;
  /** A watched item from the cache. Any other is read live and flagged `unwatched`, without being stored; null when it can't be read. */
  cacheItem(ref: ItemRef): Promise<WorkItem | null>;
  /** Reads an item live, never from the cache and never storing it, flagged `unwatched` when its container isn't watched. Null when it doesn't exist or can't be seen. */
  peekItem(ref: ItemRef): Promise<WorkItem | null>;
  /** Watched containers only, unless `includeUnwatched`. */
  cacheContainers(opts?: ReadScope): Promise<WorkContainer[]>;
  /** People the cache has seen, so views can name an assignee. */
  cachePeople(): Promise<Person[]>;
  /** The signed-in person, so views can tell which items are theirs. */
  cacheMe(): Promise<WorkIdentity>;
  /**
   * An item's comments, oldest first. Without `refresh` they come from the cache; with it, from the tracker, falling
   * back to the cache when it can't be reached.
   */
  cacheComments(ref: ItemRef, refresh: boolean): Promise<WorkComment[]>;
  /** The moves open to one item right now. A tracker that reveals workflows per item is the only place to ask. */
  cacheTransitions(ref: ItemRef): Promise<WorkMove[]>;
  /** The signed-in connections with their sync state and what the last probe found. With `refresh`, every instance is probed first. */
  connectionsList(refresh?: boolean): Promise<ConnectionInfo[]>;
  /** Opens Terminal on the fix the last probe of instance `instanceId` found. The command is the one Gossamr holds for it, never a string from the page. */
  connectionOpenTerminal(instanceId: string): Promise<void>;
  /** Saves the name Settings shows for instance `instanceId`. */
  connectionRename(instanceId: string, displayName: string): Promise<void>;
  /** Which ways of connecting GitHub work here. */
  githubSignInOptions(): Promise<GithubSignInOptions>;
  /** Validates a personal access token (classic or fine-grained) and connects the account it belongs to. */
  githubConnectToken(token: string): Promise<ConnectionInfo>;
  /** Connects with the token `gh auth token` prints. Runs `gh` only when this is called. */
  githubImportGhToken(): Promise<ConnectionInfo>;
  /** Starts the browser device flow: show `userCode`, open `verificationUri`, then await `githubDevicePoll`. */
  githubDeviceStart(): Promise<DeviceStart>;
  /** Resolves with the connection once the code is authorised; rejects if it expires or is denied. */
  githubDevicePoll(): Promise<ConnectionInfo>;
  /** Forgets the account's token and deletes what was cached for it. */
  githubDisconnect(connectionId: string): Promise<void>;
  /** The pull requests, branches and commits that name a work item, from the cache. Instant; only watched repositories. Strongest first. */
  devLinks(item: ItemRef): Promise<DevLink[]>;
  /** Searches the watched repositories for the item's key, caches what it finds and returns the links. Slower; for when a person opens the item. */
  devLinksLive(item: ItemRef): Promise<DevLink[]>;
  /** Called when a sync or a live search changed which work items are linked to code. Returns an unsubscribe function. */
  onDevLinksChanged(listener: (change: DevLinksChanged) => void): () => void;
  /** A pull request with its files, recent commits and reviews. Watched repositories only. */
  codePullRequest(ref: CodeRef): Promise<PullRequestDetail>;
  /** A pull request in a watched repository with the files it changes and their patches, for review draft hunks. Reads only. */
  codePullDiff(connectionId: string, repo: string, number: number): Promise<PullDiff>;
  /** Whether the token may post a review on a watched repository, and why not when it can't. Reads only. */
  codeReviewAccess(connectionId: string, repo: string): Promise<ReviewAccess>;
  /** Events recorded for an item, newest first. */
  cacheEvents(ref: ItemRef): Promise<WorkEvent[]>;
  /** Events across every item, newest first, one page at a time. Reading state (`unread`) is the inbox's, so `setUnread` marks an entry read. */
  cacheFeed(query: FeedQuery): Promise<FeedPage>;
  /** How many feed entries are unread, of `kinds` (every kind when none are given), as `cacheFeed` counts them. */
  cacheFeedUnread(kinds?: FeedQuery["kinds"]): Promise<number>;
  /** Called when a sync or a write changed the cache, so views over it can re-read. Returns an unsubscribe function. */
  onCacheChanged(listener: (change: CacheChanged) => void): () => void;
  /** Drafted writes, newest first. They survive a restart. */
  proposalsList(query?: ProposalQuery): Promise<Proposal[]>;
  /** Drafts a write the person made by hand, such as dropping a card on a column. Nothing is written until it is approved. */
  proposalsCreate(intent: Intent, label?: string | null): Promise<Proposal>;
  /** Replaces a pending draft's payload. */
  proposalsEdit(id: string, edit: ProposalEdit): Promise<Proposal>;
  proposalsSkip(id: string): Promise<Proposal>;
  /** The person's Undo of a skip: a draft skipped a moment ago (within about a minute) is pending again, as it was. Refused for an older skip or a draft in any other state. */
  proposalsUnskip(id: string): Promise<Proposal>;
  /**
   * Applies a pending draft; nothing else writes on the assistant's behalf. A failed attempt resolves with the draft
   * back to pending and `error` set, and subtasks it did create remembered so a retry doesn't repeat them.
   */
  proposalsApprove(id: string): Promise<Proposal>;
  /**
   * Posts a pending `githubReview` draft to GitHub as one comment review: the only write to GitHub, and only the
   * person's approval calls it. A refusal resolves with the draft back to pending and `error` set; GitHub finding its
   * lines outdated sets `REVIEW_OUTDATED_NOTE`.
   */
  /**
   * `revisions` is how many revisions the draft had as the person saw it: one revised since is refused (`REVIEW_CHANGED`).
   * A draft with `maybePosted` set is looked for on GitHub rather than sent; `postAnyway`, the person's explicit choice once
   * it wasn't found, sends it.
   */
  proposalsPostReview(id: string, revisions: number, postAnyway?: boolean): Promise<Proposal>;
  /** Called when drafts changed, including by a sync revising or retiring them. Returns an unsubscribe function. */
  onProposalsChanged(listener: (change: ProposalsChanged) => void): () => void;
  /** Background agent runs, newest first. */
  runsList(query?: RunQuery): Promise<Run[]>;
  /** Stops a working run; rejects until it is working. */
  runsStop(id: string): Promise<Run>;
  /** Answers a run that is asking a question: hands the answer to the agent waiting in its ask call, or stops its session and wakes it when its turn ended. Also sends again an answer that was stopped on its way. */
  runsAnswer(id: string, text: string): Promise<Run>;
  /** Takes a listed session over as the continuation of a stopped or finished run. */
  runsAdoptSession(id: string, session: string): Promise<Run>;
  /** Stops every active run, across accounts, and the runs waiting for a slot (`waiting`); nothing starts in the slots it frees. */
  runsStopAll(): Promise<{ stopped: number; failed: number; waiting: number }>;
  /** Opens Terminal attached to the run's session. */
  runsAttach(id: string): Promise<void>;
  /** Opens Terminal in the run's clone running `claude`, so the person can accept Claude's trust question. Rejects unless the run failed because its folder isn't trusted. */
  runsTrustFolder(id: string): Promise<void>;
  /** Opens Terminal in the run's clone running claude in the refused permission mode, so the person can accept it once. Rejects unless the run failed because `--bg` refused that mode. */
  runsAcceptMode(id: string, mode: "auto" | "bypass"): Promise<void>;
  /** Opens Terminal in the run's clone running `claude`, so the person can sign in. Rejects unless the run failed because Claude isn't signed in. */
  runsSignIn(id: string): Promise<void>;
  /** Local clones of a watched repository, the one the person chose first. */
  runsClones(repo: string): Promise<CloneChoice>;
  runsPickClone(repo: string, path: string): Promise<void>;
  /** Clones a watched repository into `~/Gossamr/agents/<owner>/<repo>` (or fetches into the copy already there). Only after the person chose it, having seen `CloneChoice.fresh`. */
  runsCloneFresh(repo: string): Promise<LocalClone>;
  runsEvents(id: string): Promise<RunEvent[]>;
  /** The part of the result meant for Jira, the tickets it names, and the pull request or branch the run produced. */
  runsOutcome(id: string): Promise<RunOutcome>;
  /** Starts a run that is still queued, as after a restart. */
  runsStartNow(id: string): Promise<Run>;
  /** How many agents carry on if the app quits or the person signs out. */
  runsKeepRunning(): Promise<number>;
  revealPath(path: string): Promise<void>;
  runsSettings(): Promise<AgentSettings>;
  /** Sets the Dock badge from the same Needs you list the page shows. */
  setNeedsBadge(count: number): Promise<void>;
  /** Whether macOS Reduce transparency is on, which WebKit doesn't report to the page. */
  reduceTransparency(): Promise<boolean>;
  onDisplayChanged(listener: () => void): () => void;
  /** Calls `listener` when a probe found something new about a connection; re-read `connectionsList`. */
  onConnectionsChanged(listener: () => void): () => void;
  /** Saves the limits, clamped by the backend, and returns what was saved. */
  runsSetSettings(settings: AgentSettings): Promise<AgentSettings>;
  /** Removes a finished run's worktree with `claude rm`. Never forces: Claude refuses unpushed work and says so. */
  runsCleanup(id: string): Promise<CleanupResult>;
  /** Archives runs that are over; returns the ids archived. A run still going is refused. */
  runsArchive(ids: string[]): Promise<string[]>;
  runsRestore(id: string): Promise<void>;
  /** Which runs `filter` would archive, and how many it keeps out for a draft or Needs you. */
  runsClearPreview(filter: ClearFilter): Promise<ClearPreview>;
  /** Archives what the preview shows, worked out again now. Returns the ids archived. */
  runsClear(filter: ClearFilter): Promise<string[]>;
  /** The worktree folder deleting this archived run could remove, and its size. */
  runsWorktreeInfo(id: string): Promise<WorktreeInfo>;
  /** Deletes an archived run's records, and its worktree inside ~/Gossamr/agents when asked. */
  runsDelete(id: string, removeWorktree: boolean): Promise<DeleteResult>;
  /** Bytes the run's session files take up. */
  runsDisk(id: string): Promise<number>;
  /** Launches a run whose launch failed, after checking that no session for it exists. */
  runsRetryLaunch(id: string): Promise<Run>;
  /** Called when a run was created or changed. Returns an unsubscribe function. */
  onRunsChanged(listener: (change: RunsChanged) => void): () => void;
  /** Called with a run id when a notification should open that run. Returns an unsubscribe function. */
  onOpenRun(listener: (runId: string) => void): () => void;
  /** Opens a workstream on a cached ticket, or with no ticket and a title. A ticket that has an open one gets that one back. */
  workstreamsOpen(item: ItemRef | null, title?: string): Promise<Workstream>;
  /** The signed-in account's workstreams with their stages, newest first; closed ones only when asked for. */
  workstreamsList(includeClosed?: boolean): Promise<WorkstreamView[]>;
  /** Closes a workstream; its runs and drafts stay as they are. */
  workstreamsClose(id: string): Promise<Workstream>;
  /** Reopens a closed workstream as it stood (the Undo of Close, and a closed row's Reopen). Refused when its ticket has another open one by now. */
  workstreamsReopen(id: string): Promise<Workstream>;
  /** The person's "Bring them here": the runs and pending drafts on the workstream's ticket that are in no workstream move into it, audited as `adopted`. Returns what moved, for `workstreamsUndo`. Refused when there are none. */
  workstreamsAdopt(id: string): Promise<Adoptable>;
  /** A workstream's append-only audit, oldest first. */
  workstreamsEvents(id: string): Promise<WorkstreamEvent[]>;
  /** The person pauses an open workstream: nothing wakes Pip in it; its runs carry on. */
  workstreamsPause(id: string): Promise<Workstream>;
  /** The person resumes a workstream, whatever paused it. */
  workstreamsResume(id: string): Promise<Workstream>;
  /** The person dismisses the question Pip asked in a workstream (`pipAsk`); false when none was open. */
  workstreamsDismissAsk(id: string): Promise<boolean>;
  /**
   * The person's Undo of "Bring them here", a moment after it: the runs and drafts it moved go back to General.
   * Allowed only while that change is the last line of the audit and under a minute old; it adds its own `undone` line.
   */
  workstreamsUndo(id: string, undo: WorkstreamUndo): Promise<Workstream>;
  /** The person stops a workstream: pauses it, then stops each of its runs that can be stopped. */
  workstreamsStop(id: string): Promise<{ stopped: number; failed: number }>;
  /** Called when a workstream was opened, closed or changed. Returns an unsubscribe function. */
  onWorkstreamsChanged(listener: (change: WorkstreamsChanged) => void): () => void;
  /** What each signed-in connection follows. */
  watchGet(): Promise<WatchState[]>;
  /** Watches, unwatches (the row goes at once; its cached items are pruned later) or pins containers. The first one watched makes the list the person's own. */
  watchSetContainers(connectionId: string, changes: WatchChange[]): Promise<void>;
  /** One page of every container the tracker has, matching the query, each marked watched or not. */
  watchCatalog(connectionId: string, query: string, cursor?: string | null): Promise<CatalogPage>;
  /** Where the person was involved in the last 90 days, for suggesting what to watch. Kept for a few hours unless `refresh`. */
  watchSuggestions(connectionId: string, refresh?: boolean): Promise<Footprint[]>;
  /** Open items assigned to the person in containers they don't watch. */
  watchUnwatchedAssigned(connectionId: string, refresh?: boolean): Promise<Stray[]>;
  /** Stops suggesting a container until something new is assigned there. */
  watchDismissAssigned(connectionId: string, containerId: string): Promise<void>;
  /** Called when the watch settings changed, by the person or by the app choosing for a small catalog. */
  onWatchChanged(listener: (change: WatchChanged) => void): () => void;
  /** Called when a periodic check finds newly assigned items in unwatched containers. */
  onAssignedElsewhere(listener: (found: AssignedElsewhere) => void): () => void;
  syncNow(): Promise<void>;
  /** The Jira site and account signed in now, with the email and token expiry the person gave. */
  jiraStatus(): Promise<AuthStatus>;
  /** The cloud id a Jira site reports about itself, or null when the person has to give it. Rejects when the site can't be reached. */
  jiraCloudId(site: string): Promise<string | null>;
  /** Checks the token against Jira and, only if it works, keeps it in place of the earlier one. */
  jiraConnect(input: TokenSignIn): Promise<AuthStatus>;
  openUrl(url: string): Promise<void>;
}
