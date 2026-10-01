import type { Mention } from "../lib/mentions";
import type {
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  CloneChoice,
  ContainerRef,
  Intent,
  ItemRef,
  Person,
  Preflight,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  Run,
  RunEvent,
  RunQuery,
  RunReview,
  RunSpec,
  RunOutcome,
  RunsChanged,
  RunsEnabledChange,
  RunsEnvironment,
  Snapshot,
  Transition,
  Uploaded,
  CodeChange,
  CodeCommitQuery,
  CodeFile,
  CodeHit,
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
  Stray,
  TreeEntry,
  WatchChange,
  WatchChanged,
  WatchMode,
  WatchState,
  WorkComment,
  WorkContainer,
  WorkIdentity,
  WorkMove,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workflow,
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
  transitions(ticketKey: string): Promise<Transition[]>;
  transition(ticketKey: string, transitionId: string): Promise<void>;
  /** Posts a comment. Each mention's `@Name` in the body becomes a real Jira mention, which notifies that person. */
  comment(ticketKey: string, body: string, mentions?: Mention[], files?: Uploaded[]): Promise<void>;
  /** Uploads a file to the ticket, to be included in a comment. */
  attach(ticketKey: string, file: File): Promise<Uploaded>;
  /** The site's per-file upload limit in bytes, or null when attachments are turned off. */
  attachmentLimit(): Promise<number | null>;
  /** Maps the media ids that documents embed to the ticket's attachment ids. */
  ticketMedia(ticketKey: string): Promise<Record<string, string>>;
  /** A URL the page can load an attachment from. */
  attachmentUrl(attachmentId: string): string;
  /** People who can see the ticket and match the query, for @mention suggestions. */
  mentionable(ticketKey: string, query: string): Promise<Person[]>;
  /** Creates sub-tasks under a ticket and returns their keys. */
  /** Stops at the first failure; `created` lists the keys made before it, in order. */
  createSubtasks(ticketKey: string, summaries: string[]): Promise<{ created: string[]; error: string | null }>;
  markSeen(ticketKey: string): Promise<void>;
  setUnread(eventId: string, unread: boolean): Promise<void>;
  setDone(eventId: string, done: boolean): Promise<void>;
  snooze(eventId: string, until: Date | null): Promise<void>;
  /** Items in the local cache that match the filter, newest first. Works offline. Only watched containers unless `includeUnwatched`. */
  cacheSearch(filter: WorkFilter, opts?: ReadScope): Promise<WorkItem[]>;
  /** A watched item from the cache. Any other is read live and flagged `unwatched`, without being stored; null when it can't be read. */
  cacheItem(ref: ItemRef): Promise<WorkItem | null>;
  /** Reads an item live, never from the cache and never storing it, flagged `unwatched` when its container isn't watched. Null when it doesn't exist or can't be seen. */
  peekItem(ref: ItemRef): Promise<WorkItem | null>;
  /** Watched containers only, unless `includeUnwatched`. */
  cacheContainers(opts?: ReadScope): Promise<WorkContainer[]>;
  cacheWorkflow(container: ContainerRef): Promise<Workflow | null>;
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
  /** The signed-in connections with their sync state. */
  connectionsList(): Promise<ConnectionInfo[]>;
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
  /** Pull requests, branches and commits in watched repositories matching the text; a work item key matches exactly. */
  codeSearch(query: string): Promise<CodeChange[]>;
  /** Pull request and notification events, newest first, for the Activity feed. `subject.type` is `codeChange`. */
  codeEvents(limit?: number): Promise<WorkEvent[]>;
  /** A text file at a ref, cut at 60,000 characters. Binary and huge files are refused. Watched repositories only. */
  codeFile(connectionId: string, repo: string, path: string, reference?: string | null): Promise<CodeFile>;
  /** A directory listing, folders first. Watched repositories only. */
  codeTree(connectionId: string, repo: string, path: string, reference?: string | null): Promise<TreeEntry[]>;
  /** Commits of a branch or ref, newest first, optionally filtered by message text. Watched repositories only. */
  codeCommits(connectionId: string, repo: string, opts?: CodeCommitQuery): Promise<CodeChange[]>;
  /** GitHub code search limited to watched repositories; `repos` narrows it further and must be watched. */
  codeSearchCode(connectionId: string, query: string, repos?: string[]): Promise<CodeHit[]>;
  /** Events recorded for an item, newest first. */
  cacheEvents(ref: ItemRef): Promise<WorkEvent[]>;
  /** Events across every item, newest first, one page at a time. Reading state (`unread`) is the inbox's, so `setUnread` marks an entry read. */
  cacheFeed(query: FeedQuery): Promise<FeedPage>;
  /** How many feed entries are unread. */
  cacheFeedUnread(): Promise<number>;
  /** Called when a sync or a write changed the cache, so views over it can re-read. Returns an unsubscribe function. */
  onCacheChanged(listener: (change: CacheChanged) => void): () => void;
  /** Drafted writes, newest first. They survive a restart. */
  proposalsList(query?: ProposalQuery): Promise<Proposal[]>;
  proposalsGet(id: string): Promise<Proposal | null>;
  /** Drafts a write the person made by hand, such as dropping a card on a column. Nothing is written until it is approved. */
  proposalsCreate(intent: Intent, label?: string | null): Promise<Proposal>;
  /** Replaces a pending draft's payload. */
  proposalsEdit(id: string, edit: ProposalEdit): Promise<Proposal>;
  proposalsSkip(id: string): Promise<Proposal>;
  /**
   * Applies a pending draft; nothing else writes on the assistant's behalf. A failed attempt resolves with the draft
   * back to pending and `error` set, and subtasks it did create remembered so a retry doesn't repeat them.
   */
  proposalsApprove(id: string): Promise<Proposal>;
  /** Called when drafts changed, including by a sync revising or retiring them. Returns an unsubscribe function. */
  onProposalsChanged(listener: (change: ProposalsChanged) => void): () => void;
  /** Background agent runs, newest first. */
  /** Whether Agents are on. The backend owns this; the page only asks. */
  runsEnabled(): Promise<boolean>;
  /** Turns Agents on or off and saves it. Turning on rejects, leaving it off, when Claude can't be set up; turning off stops nothing. */
  runsSetEnabled(enabled: boolean): Promise<RunsEnabledChange>;
  runsList(query?: RunQuery): Promise<Run[]>;
  runsGet(id: string): Promise<Run | null>;
  /** The exact prompt a `startRun` draft would send, and the digest that approves it. */
  runsReview(proposalId: string): Promise<RunReview>;
  /**
   * Starts a `startRun` draft, the only way one is approved. `digest` is from the review the person read; a draft that
   * changed since rejects with "This draft changed after you read it. Review it again."
   */
  runsApprove(proposalId: string, digest: string): Promise<Run>;
  /** Stops a working run; rejects until it is working. */
  runsStop(id: string): Promise<Run>;
  /** Answers a run that is asking a question: stops its session and wakes it with the answer. Also sends again an answer that was stopped on its way. */
  runsAnswer(id: string, text: string): Promise<Run>;
  /** Stops every active run, across accounts. */
  runsStopAll(): Promise<{ stopped: number; failed: number }>;
  /** Opens Terminal attached to the run's session. */
  runsAttach(id: string): Promise<void>;
  /** Opens Terminal in the run's clone running `claude`, so the person can accept Claude's trust question. Rejects unless the run failed because its folder isn't trusted. */
  runsTrustFolder(id: string): Promise<void>;
  /** Opens Terminal in the run's clone running `claude`, so the person can sign in. Rejects unless the run failed because Claude isn't signed in. */
  runsSignIn(id: string): Promise<void>;
  /** What a run would need and run as; with no spec, only the environment and capacity. */
  runsPreflight(spec: RunSpec | null): Promise<Preflight>;
  /** Drafts a run by hand. The backend fills in the ticket text; nothing starts until `runsApprove`. */
  runsDraft(spec: RunSpec, item: ItemRef | null): Promise<Proposal>;
  /** Every repository watched on any GitHub connection as owner/name, sorted. */
  runsRepos(): Promise<string[]>;
  /** Local clones of a watched repository, the one the person chose first. */
  runsClones(repo: string): Promise<CloneChoice>;
  runsPickClone(repo: string, path: string): Promise<void>;
  /** A worktree name for a new run in `clonePath` that nothing there uses yet. */
  runsSuggestName(clonePath: string, key: string, title: string): Promise<string>;
  runsEvents(id: string): Promise<RunEvent[]>;
  /** The part of the result meant for Jira, the tickets it names, and the pull request or branch the run produced. */
  runsOutcome(id: string): Promise<RunOutcome>;
  /** Drafts a comment from the result. A draft only: nothing is posted until it is approved. */
  runsDraftComment(id: string): Promise<Proposal>;
  /** Drafts a link saying the run's ticket is blocked by `blockerKey`. A draft only. */
  runsDraftBlocker(id: string, blockerKey: string): Promise<Proposal>;
  /** Starts a run that is still queued, as after a restart. */
  runsStartNow(id: string): Promise<Run>;
  /** How many agents carry on if the app quits or the person signs out. */
  runsKeepRunning(): Promise<number>;
  revealPath(path: string): Promise<void>;
  /** Whether Claude Code is installed and signed in, for the banners on the Agents view. Never rejects. */
  runsEnvironment(): Promise<RunsEnvironment>;
  /** Bytes the run's session files take up. */
  runsDisk(id: string): Promise<number>;
  /** Launches a run whose launch failed, after checking that no session for it exists. */
  runsRetryLaunch(id: string): Promise<Run>;
  /** Called when a run was created or changed. Returns an unsubscribe function. */
  onRunsChanged(listener: (change: RunsChanged) => void): () => void;
  /** Called with a run id when a notification should open that run. Returns an unsubscribe function. */
  onOpenRun(listener: (runId: string) => void): () => void;
  /** What each signed-in connection follows. */
  watchGet(): Promise<WatchState[]>;
  /** Choosing `selected` with nothing watched yet syncs nothing; add containers with `watchSetContainers`. */
  watchSetMode(connectionId: string, mode: WatchMode): Promise<void>;
  /** Watches, unwatches (softly: hidden at once, deleted after 14 days), pins, or sets the depth of containers. */
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
  openUrl(url: string): Promise<void>;
  /** Releases anything the backend holds, when the app switches to another one. */
  dispose?(): void;
}
