import { isInboxView, projectsOf, relativeTime, viewCounts } from "../lib/views";
import { useStore } from "../store";
import { Icon, VIEW_ICON } from "./icons";

const SECTIONS = [
  { id: "inbox", label: "Inbox" },
  { id: "work", label: "My work" },
] as const;

const PROJECT_COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

export function Sidebar() {
  const { snap, now, view, project, setView, backend, account, signOut } = useStore();
  if (!snap) return null;
  const counts = viewCounts(snap, now);
  const navItem = "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-hover";

  return (
    <aside className="sidebar flex min-h-0 flex-col border-r border-sep bg-side max-[1040px]:hidden">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <nav className="px-2">
        {SECTIONS.map((v) => {
          const current = (v.id === "inbox" ? isInboxView(view) : view === v.id) && !project;
          const hot = v.id === "inbox" && counts.inbox > 0;
          return (
            <button
              key={v.id}
              type="button"
              aria-current={current}
              onClick={() => setView(v.id)}
              className={`${navItem} ${current ? "bg-side-sel font-semibold" : ""}`}
            >
              <Icon name={VIEW_ICON[v.id]} className="size-[15px] text-accent" />
              {v.label}
              <span className={`ml-auto text-xs tabular-nums ${hot ? "font-semibold text-ink-2" : "text-ink-3"}`}>
                {counts[v.id] || ""}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="px-2">
        <div className="px-2 pt-3 pb-1 text-xs font-semibold text-ink-3">Projects</div>
        {projectsOf(snap).map((p, i) => (
          <button
            key={p}
            type="button"
            aria-current={project === p}
            onClick={() => setView("inbox", project === p ? null : p)}
            className={`${navItem} ${project === p ? "bg-side-sel font-semibold" : ""}`}
          >
            <span className="size-2.5 rounded-[3px]" style={{ background: PROJECT_COLOURS[i % PROJECT_COLOURS.length] }} />
            {p}
          </button>
        ))}
      </div>

      <div className="mt-auto grid gap-1.5 border-t border-sep px-3.5 py-3 text-[11.5px] text-ink-2">
        {snap.syncError ? (
          <div className="flex items-start gap-1.5 text-blocked" title={snap.syncError}>
            <span className="mt-1 size-[7px] shrink-0 rounded-full bg-blocked" />
            <span className="line-clamp-2">Sync failed: {snap.syncError}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="size-[7px] rounded-full bg-[#28c840]" />
            {syncLabel(snap.lastSyncAt, now)}
          </div>
        )}
        <div className="truncate" title={account?.site.url}>
          {account ? `${account.me.name} · ${account.site.name}` : "Sample data"}
        </div>
        {account && (
          <button type="button" className="text-left text-accent" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
        {backend && (
          <button type="button" className="text-left text-accent" onClick={() => void backend.syncNow()}>
            {backend.kind === "mock" ? "Simulate a new notification" : "Sync now"}
          </button>
        )}
      </div>
    </aside>
  );
}

function syncLabel(lastSyncAt: string | null, now: Date) {
  if (!lastSyncAt) return "Syncing…";
  const rel = relativeTime(lastSyncAt, now);
  if (rel === "now") return "Synced just now";
  return rel === "Yday" ? "Synced yesterday" : `Synced ${rel} ago`;
}
