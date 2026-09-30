import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import type { CatalogEntry, Footprint, Stray, WatchState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { PeekView } from "./PeekSheet";
import { ProjectsMenuPanel } from "./Rail";
import { PeekBanner, StrayList } from "./WatchNotices";
import { WatchPickerView, type WatchPickerViewProps } from "./WatchPicker";
import { ModeConfirm, SettingsRowView, WatchCardView, type WatchCardViewProps } from "./WatchSettings";
import { settingsRows, type SettingsRow } from "./watchLogic";

const noun = { one: "project", many: "projects" };
const fn = () => vi.fn();
const fp = (key: string, over: Partial<Footprint> = {}): Footprint => ({ container: containerRef(key), key, name: `${key} project`, assigned: 0, reported: 0, watching: 0, commented: null, mentioned: null, lastTouch: null, ...over });
const entry = (key: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({ ref: containerRef(key), key, name: `${key} project`, kind: null, archived: false, lastActive: null, itemHint: null, watched: false, ...over });
const ready = { entries: [entry("P05", { itemHint: 7 }), entry("P06")], status: "ready" as const, error: null, offline: false, hasMore: false, loadingMore: false };

const picker = (over: Partial<WatchPickerViewProps> = {}) =>
  renderToStaticMarkup(
    <WatchPickerView
      noun={noun}
      workspace="Acme"
      query=""
      suggested={{ status: "ready", list: [fp("WEB", { assigned: 4, reported: 1 }), fp("CA")] }}
      catalog={ready}
      selected={new Set(["WEB", "CA"])}
      saving={false}
      saveError={null}
      onQuery={fn()}
      onToggle={fn()}
      onSelectNone={fn()}
      onSelectSuggested={fn()}
      onLoadMore={fn()}
      onRetry={fn()}
      onSave={fn()}
      onEverything={fn()}
      {...over}
    />,
  );

describe("the forced picker", () => {
  it("shows the suggestions first, ticked, with why, then the rest, and a summary", () => {
    const out = picker();
    expect(out).toContain("Choose what to watch");
    expect(out.indexOf("Suggested for you")).toBeLessThan(out.indexOf("All projects"));
    expect(out).toContain("4 assigned · 1 reported");
    expect(out.match(/checked=""/g)).toHaveLength(2);
    expect(out).toContain("2 selected");
    expect(out).toContain("Start watching");
    expect(out).toContain("7 items");
  });

  it("does not list a suggested container twice", () => {
    const out = picker({ catalog: { ...ready, entries: [entry("WEB"), entry("P05")] } });
    expect(out.match(/WEB project/g)).toHaveLength(1);
  });

  it("offers a clearly labelled watch-everything button with the cost, and no way out without choosing", () => {
    const out = picker();
    expect(out).toContain("Watch everything");
    expect(out).toContain("slower");
    expect(out).not.toContain("Cancel");
    expect(picker({ onCancel: fn() })).toContain("Cancel");
  });

  it("cannot be saved with nothing chosen, or while saving", () => {
    expect(picker({ selected: new Set() })).toMatch(/<button[^>]*disabled=""[^>]*>Start watching/);
    expect(picker({ saving: true })).toContain("Saving…");
    expect(picker({ saveError: "Nope" })).toContain('role="alert"');
  });

  it("searches across the catalog and drops the suggested section", () => {
    const out = picker({ query: "p0", catalog: { ...ready, entries: [entry("P05")] } });
    expect(out).not.toContain("Suggested for you");
    expect(out).toContain("Matching");
    expect(out).toContain("P05 project");
  });

  it("says so when nothing matches, while loading, offline, and when the list can't load", () => {
    expect(picker({ query: "zzz", catalog: { ...ready, entries: [] } })).toContain("No projects match");
    expect(picker({ suggested: { status: "loading", list: [] }, catalog: { ...ready, entries: [], status: "loading" } })).toContain("Loading projects…");
    expect(picker({ catalog: { ...ready, offline: true } })).toContain("You&#x27;re offline");
    const failed = picker({ suggested: { status: "error", list: [] }, catalog: { ...ready, entries: [], status: "error", error: "Timed out" } });
    expect(failed).toContain("Timed out");
    expect(failed).toContain("Try again");
    expect(failed).toContain("Watch everything");
  });

  it("pages with a sentinel while more remain", () => {
    expect(picker({ catalog: { ...ready, hasMore: true } })).toContain("Load more");
    expect(picker({ catalog: { ...ready, hasMore: true, loadingMore: true } })).toContain("Loading more…");
    expect(picker()).not.toContain("Load more");
  });

  it("uses the connection's word for its containers", () => {
    const out = picker({ noun: { one: "team", many: "teams" } });
    expect(out).toContain("Search teams");
    expect(out).toContain("All teams");
    expect(out).not.toMatch(/projects|project you/);
  });
});

describe("settings rows", () => {
  const base: SettingsRow = { container: containerRef("WEB"), key: "WEB", name: "Webshop", depth: "involved", pinned: false, unwatchedAt: null, inaccessible: false, cachedItems: 9 };
  const row = (over: Partial<SettingsRow> = {}, pinOnly = false) =>
    renderToStaticMarkup(<SettingsRowView row={{ ...base, ...over }} noun={noun} now={new Date("2026-09-30T12:00:00Z")} pinOnly={pinOnly} onDepth={fn()} onPin={fn()} onUnwatch={fn()} onUndo={fn()} />);

  it("shows the depth, pin and unwatch controls for a watched row", () => {
    const out = row();
    expect(out).toContain('aria-label="Depth for Webshop"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain("Whole project");
    expect(out).toContain('aria-label="Pin Webshop to the rail"');
    expect(out).toContain('aria-label="Unwatch Webshop"');
    expect(out).toContain("9 tickets synced");
  });

  it("marks a pinned row pressed and a whole-project row checked", () => {
    const out = row({ pinned: true, depth: "whole" });
    expect(out).toContain('aria-label="Unpin Webshop from the rail"');
    expect(out).toContain('aria-pressed="true"');
  });

  it("says how long a row has before it is removed, with undo instead of the controls", () => {
    const out = row({ unwatchedAt: "2026-09-27T12:00:00Z" });
    expect(out).toContain("Unwatched, removed from sync in 11 days");
    expect(out).toContain("Undo");
    expect(out).not.toContain("Depth for");
    expect(out).not.toContain("Unwatch Webshop");
  });

  it("warns about a container the tracker refuses", () => {
    expect(row({ inaccessible: true })).toContain("Can&#x27;t be reached");
    expect(row()).not.toContain("Can&#x27;t be reached");
  });

  it("offers only pinning in everything mode", () => {
    const out = row({}, true);
    expect(out).toContain("Pin Webshop");
    expect(out).not.toContain("Depth for");
    expect(out).not.toContain("Unwatch Webshop");
  });
});

describe("the watching card", () => {
  const state = (mode: WatchState["mode"]): WatchState => ({ connectionId: "mock", mode, needsChoice: false, catalogSize: 13, watches: [] });
  const card = (mode: WatchState["mode"], over: Partial<WatchCardViewProps> = {}) => {
    const s = state(mode);
    const rows = settingsRows({ ...s, watches: [{ container: containerRef("WEB"), depth: "involved", pinned: true, source: "manual", addedAt: "", unwatchedAt: null, inaccessible: false, key: "WEB", name: "Webshop", cachedItems: 9 }] }, []);
    return renderToStaticMarkup(
      <WatchCardView
        title="Acme"
        account="Alf"
        noun={noun}
        state={s}
        rows={rows}
        query=""
        now={new Date("2026-09-30T12:00:00Z")}
        sync={{ text: "Last synced 3m ago", tone: "ok" }}
        chips={[fp("CA", { assigned: 2 })]}
        find={ready}
        confirm={null}
        onQuery={fn()}
        onMode={fn()}
        onConfirm={fn()}
        onCancelConfirm={fn()}
        onChip={fn()}
        onDepth={fn()}
        onPin={fn()}
        onUnwatch={fn()}
        onUndo={fn()}
        onWatch={fn()}
        onLoadMore={fn()}
        onRetry={fn()}
        {...over}
      />,
    );
  };

  it("shows the sync line, the mode switch, suggestion chips, the watched list and what can be added", () => {
    const out = card("selected");
    expect(out).toContain("Last synced 3m ago");
    expect(out).toContain('aria-label="What to watch"');
    expect(out).toContain("Suggested from your last 90 days");
    expect(out).toContain('aria-label="Watch CA project"');
    expect(out).toContain("Webshop");
    expect(out).toContain("Add projects");
    expect(out).toContain("P05 project");
  });

  it("hides the add list and the chips in everything mode", () => {
    const out = card("everything");
    expect(out).toContain("Watching every project you can see");
    expect(out).not.toContain("Add projects");
    expect(out).not.toContain("Suggested from");
  });

  it("does not offer to add a container that is already listed", () => {
    const out = card("selected", { find: { ...ready, entries: [entry("WEB"), entry("P05")] } });
    expect(out).toContain("P05 project");
    expect(out).not.toContain('aria-label="Watch WEB project"');
  });

  it("asks before switching either way", () => {
    expect(card("selected", { confirm: "everything" })).toContain("Watch every project you can see? Syncing gets slower");
    const toSelected = renderToStaticMarkup(<ModeConfirm to="selected" noun={noun} onConfirm={fn()} onCancel={fn()} />);
    expect(toSelected).toContain("Choose projects…");
    expect(toSelected).toContain("nothing changes until you save");
    expect(card("everything")).not.toContain("alertdialog");
  });
});

describe("the rail menu", () => {
  const rest = [{ ref: containerRef("SUP"), key: "SUP", name: "Support" }, { ref: containerRef("WEB"), key: "WEB", name: "Webshop" }] as never;
  const panel = (query = "", list = rest) => renderToStaticMarkup(<ProjectsMenuPanel rest={list} colourOf={() => "#123456"} noun={noun} query={query} onQuery={fn()} onPick={fn()} onManage={fn()} />);

  it("lists the watched containers without a badge, with a search and a link to manage them", () => {
    const out = panel();
    expect(out).toContain("Support");
    expect(out).toContain("Webshop");
    expect(out).toContain('aria-label="Search watched projects"');
    expect(out).toContain("Manage projects…");
  });

  it("narrows by the query and says when nothing is left", () => {
    expect(panel("shop")).not.toContain("Support");
    expect(panel("zzz")).toContain("No watched project matches.");
    expect(panel("", [] as never)).toContain("Every project you watch is pinned.");
  });
});

describe("the read-only peek", () => {
  it("says you aren't watching the project and offers to watch it or ask Pip", () => {
    const out = renderToStaticMarkup(<PeekBanner unwatched containerName="Support" noun={noun} onWatch={fn()} onAskPip={fn()} />);
    expect(out).toContain("You&#x27;re not watching Support. This is a live read-only view.");
    expect(out).toContain("Watch project");
    expect(out).toContain("Ask Pip about this ticket");
  });

  it("falls back to the container word when the name isn't known", () => {
    expect(renderToStaticMarkup(<PeekBanner unwatched containerName={null} noun={noun} onWatch={fn()} onAskPip={fn()} />)).toContain("not watching this project.");
  });

  it("offers no watch button for a ticket in a watched project that simply isn't synced", () => {
    const out = renderToStaticMarkup(<PeekBanner unwatched={false} containerName={null} noun={noun} onWatch={fn()} onAskPip={fn()} />);
    expect(out).not.toContain("Watch project");
    expect(out).toContain("live read-only view");
  });

  describe("in the sheet", () => {
    beforeEach(async () => {
      vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
      await useWorkspace.getState().init(new MockBackend());
    });

    it("shows the banner above the title and no composer", () => {
      const item = useWorkspace.getState().items["mock:DEVOPS-473"];
      const out = renderToStaticMarkup(
        <PeekView
          item={item}
          assignee="Jonas Berg"
          now={new Date("2026-09-30T12:00:00Z")}
          moves={[]}
          menuOpen={false}
          links={[]}
          comments={[]}
          history={[]}
          description={<p>Body</p>}
          drafts={null}
          composer={null}
          notice={null}
          banner={<PeekBanner unwatched containerName="DevOps" noun={noun} onWatch={fn()} onAskPip={fn()} />}
          onMenu={fn()}
          onMove={fn()}
          onLink={fn()}
          onOpen={fn()}
          onClose={fn()}
        />,
      );
      expect(out.indexOf("not watching DevOps")).toBeLessThan(out.indexOf(item.title));
      expect(out).not.toContain("Draft comment");
    });
  });
});

describe("items assigned elsewhere", () => {
  const stray: Stray = { container: containerRef("SUP"), containerName: "Support", keys: ["SUP-12", "SUP-13"] };
  const list = (strays: Stray[]) => renderToStaticMarkup(<StrayList strays={strays} noun={() => noun} busy={null} onOpen={fn()} onWatch={fn()} onDismiss={fn()} />);

  it("shows what was assigned, in which container, with watch and dismiss", () => {
    const out = list([stray]);
    expect(out).toContain("You were assigned SUP-12 and 1 more in Support, which you&#x27;re not watching.");
    expect(out).toContain("Watch project");
    expect(out).toContain("Dismiss");
    expect(out).toContain("SUP-13");
  });

  it("renders nothing when there are none", () => {
    expect(list([])).toBe("");
  });
});
