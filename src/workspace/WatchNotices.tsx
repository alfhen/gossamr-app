import { useState } from "react";
import type { Stray } from "../types";
import { useWorkspace } from "../workspaceStore";
import { askPip } from "./askPip";
import { openTicketByKey } from "./jump";
import { nounFor, strayText, type Noun } from "./watchLogic";

const link = "rounded-md px-2 py-0.5 text-sm font-semibold hover:bg-ws-hover";

export interface PeekBannerProps {
  /** The container is one the person doesn't watch. Otherwise the ticket is only missing from the synced ones. */
  unwatched: boolean;
  containerName: string | null;
  noun: Noun;
  busy?: boolean;
  onWatch(): void;
  onAskPip(): void;
}

export function PeekBanner({ unwatched, containerName, noun, busy, onWatch, onAskPip }: PeekBannerProps) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-ws-sep2 bg-ws-bar px-3 py-1.5 text-sm text-ws-ink2">
      <span className="min-w-0 flex-1">
        {unwatched ? `You're not watching ${containerName ?? `this ${noun.one}`}.` : "This ticket isn't one of your synced tickets."} This is a live read-only view.
      </span>
      {unwatched && (
        <button type="button" disabled={busy} onClick={onWatch} className={`${link} text-ws-accent disabled:opacity-45`}>
          Watch {noun.one}
        </button>
      )}
      <button type="button" onClick={onAskPip} className={`${link} text-ws-pip`}>
        Ask Pip about this ticket
      </button>
    </div>
  );
}

export interface StrayCardProps {
  stray: Stray;
  noun: Noun;
  busy?: boolean;
  onOpen(key: string): void;
  onWatch(): void;
  onDismiss(): void;
}

export function StrayCard({ stray, noun, busy, onOpen, onWatch, onDismiss }: StrayCardProps) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ws-pip bg-ws-pip-soft px-3 py-2">
      <div className="min-w-0 flex-1">
        <div>{strayText(stray)}.</div>
        <div className="flex flex-wrap gap-x-2 text-sm">
          {stray.keys.slice(0, 6).map((k) => (
            <button key={k} type="button" onClick={() => onOpen(k)} className="font-mono font-semibold text-ws-ink2 hover:underline">
              {k}
            </button>
          ))}
          {stray.keys.length > 6 && <span className="text-ws-ink3">and {stray.keys.length - 6} more</span>}
        </div>
      </div>
      <button type="button" disabled={busy} onClick={onWatch} className={`${link} text-ws-accent disabled:opacity-45`}>
        Watch {noun.one}
      </button>
      <button type="button" disabled={busy} onClick={onDismiss} className={`${link} text-ws-ink2 disabled:opacity-45`}>
        Dismiss
      </button>
    </li>
  );
}

export function StrayList({ strays, noun, busy, onOpen, onWatch, onDismiss }: { strays: Stray[]; noun: (s: Stray) => Noun; busy: string | null; onOpen(key: string): void; onWatch(s: Stray): void; onDismiss(s: Stray): void }) {
  if (!strays.length) return null;
  return (
    <ul aria-label="Assigned in projects you don't watch" className="m-0 grid list-none gap-2 p-0 pt-3">
      {strays.map((s) => (
        <StrayCard key={`${s.container.connectionId}:${s.container.externalId}`} stray={s} noun={noun(s)} busy={busy === s.container.externalId} onOpen={onOpen} onWatch={() => onWatch(s)} onDismiss={() => onDismiss(s)} />
      ))}
    </ul>
  );
}

/** The Activity entries for items assigned in containers that aren't watched. */
export function StrayNotices() {
  const strays = useWorkspace((s) => s.strays);
  const connections = useWorkspace((s) => s.connections);
  const [busy, setBusy] = useState<string | null>(null);
  const nounOf = (s: Stray) => nounFor(connections.find((c) => c.id === s.container.connectionId)?.kind);
  const watch = async (s: Stray) => {
    setBusy(s.container.externalId);
    try {
      await useWorkspace.getState().watchContainers(s.container.connectionId, [{ containerId: s.container.externalId, watched: true, source: "manual" }]);
    } catch (e) {
      useWorkspace.getState().report(`Couldn't watch ${s.containerName}`, e);
    } finally {
      setBusy(null);
    }
  };
  return <StrayList strays={strays} noun={nounOf} busy={busy} onOpen={(k) => void openTicketByKey(k)} onWatch={(s) => void watch(s)} onDismiss={(s) => void useWorkspace.getState().dismissStray(s)} />;
}

export function PeekNotice({ unwatched, containerName, connectionId, containerId }: { unwatched: boolean; containerName: string | null; connectionId: string; containerId: string }) {
  const kind = useWorkspace((s) => s.connections.find((c) => c.id === connectionId)?.kind);
  const [busy, setBusy] = useState(false);
  const watch = async () => {
    setBusy(true);
    try {
      await useWorkspace.getState().watchContainers(connectionId, [{ containerId, watched: true, source: "manual" }]);
    } catch (e) {
      useWorkspace.getState().report(`Couldn't watch ${containerName ?? "it"}`, e);
    } finally {
      setBusy(false);
    }
  };
  return <PeekBanner unwatched={unwatched} containerName={containerName} noun={nounFor(kind)} busy={busy} onWatch={() => void watch()} onAskPip={() => askPip("What is the state of this ticket, and what should I do about it?")} />;
}
