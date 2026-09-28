import { projectsOf, relativeTime, viewCounts, VIEWS } from "../lib/views";
import { useStore } from "../store";
import { Icon, VIEW_ICON } from "./icons";

const PROJECT_COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

export function Sidebar() {
  const { snap, now, view, project, setView, backend } = useStore();
  if (!snap) return null;
  const counts = viewCounts(snap, now);
  const navItem = "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-hover";

  return (
    <aside className="sidebar flex min-h-0 flex-col border-r border-sep bg-side max-[1040px]:hidden">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <nav className="px-2">
        {VIEWS.map((v) => {
          const current = view === v.id && !project;
          const hot = (v.id === "inbox" || v.id === "mentions") && counts[v.id] > 0;
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
        <div className="flex items-center gap-1.5">
          <span className="size-[7px] rounded-full bg-[#28c840]" />
          {snap.lastSyncAt ? `Synced ${relativeTime(snap.lastSyncAt, now) === "now" ? "just now" : relativeTime(snap.lastSyncAt, now) + " ago"}` : "Not synced yet"}
        </div>
        <div className="truncate">{snap.site}</div>
        {backend?.kind === "mock" && (
          <button type="button" className="text-left text-accent" onClick={() => void backend.syncNow()}>
            Simulate a new notification
          </button>
        )}
      </div>
    </aside>
  );
}
