import { useEffect } from "react";
import { Button } from "../components/Button";
import { itemKey } from "../lib/filter";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { ConnectFrame } from "./ConnectGithub";
import { useKeyChooser } from "./keyChooserStore";

export interface KeyChooserOption {
  ref: ItemRef;
  site: string;
  /** The ticket's title when it is synced; null when it would be read live. */
  title: string | null;
}

export function KeyChooserView({ keyName, options, onPick }: { keyName: string; options: KeyChooserOption[]; onPick(ref: ItemRef | null): void }) {
  return (
    <div className="grid gap-3.5">
      <div>
        <h2 className="font-display m-0 text-lg font-semibold">Which {keyName}?</h2>
        <p className="mt-1 mb-0 text-ws-ink2">More than one of your Jira sites has this key.</p>
      </div>
      <ul aria-label="Sites" className="m-0 list-none border-y border-ws-sep p-0">
        {options.map((o) => (
          <li key={itemKey(o.ref)} className="flex items-center gap-3 border-b border-ws-sep py-2 last:border-b-0">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold">{o.site}</span>
              {o.title && <span className="ml-2 text-sm text-ws-ink3">{o.title}</span>}
            </span>
            <Button variant="plain" size="sm" aria-label={`Open ${keyName} on ${o.site}`} onClick={() => onPick(o.ref)}>
              Open
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button variant="quiet" size="lg" onClick={() => onPick(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The sheet a typed ticket key opens when more than one site has it. */
export function KeyChooser() {
  const asking = useKeyChooser((s) => s.asking);
  const connections = useWorkspace((s) => s.connections);
  const items = useWorkspace((s) => s.items);
  const answer = useKeyChooser((s) => s.answer);
  useEffect(() => {
    if (!asking) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      answer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, answer]);
  if (!asking) return null;
  const options = asking.options.map((ref) => ({ ref, site: connections.find((c) => c.id === ref.connectionId)?.displayName ?? ref.connectionId, title: items[itemKey(ref)]?.title ?? null }));
  return (
    <ConnectFrame label={`Which ${asking.key}`} onClose={() => answer(null)} takesEscape>
      <KeyChooserView keyName={asking.key} options={options} onPick={answer} />
    </ConnectFrame>
  );
}
