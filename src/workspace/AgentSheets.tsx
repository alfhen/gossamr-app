import { useEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "../backend/useBackend";
import { agentId } from "./AgentCard";
import { AgentsSettingsView } from "./AgentsSettings";
import { pickerOpen } from "./AgentSheet";
import { RunSheet } from "./RunSheet";
import { stoppable } from "./agentsLogic";
import { sheetKey } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { bulkCleanup, cleanable, cleanupReport } from "./cleanupLogic";
import { messageOf, useToasts } from "./toasts";
import type { AgentSettings } from "../types";
import { isTypingTarget } from "../lib/keys";

const typing = (t: EventTarget | null) => isTypingTarget(t) || (t instanceof HTMLElement && !!t.closest("[data-esc-local]"));

function Settings() {
  const backend = useBackend();
  const runs = useRuns((s) => s.runs);
  const stopping = useRuns((s) => s.stopping);
  const [keepRunning, setKeepRunning] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    backend?.runsKeepRunning().then((n) => live && setKeepRunning(n), () => {});
    return () => {
      live = false;
    };
  }, [backend, runs]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  useEffect(() => {
    let live = true;
    backend?.runsSettings().then((s) => live && setSettings(s), () => {});
    return () => {
      live = false;
    };
  }, [backend]);
  const saving = useRef(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const save = (next: AgentSettings) => {
    if (!backend || saving.current) return;
    saving.current = true;
    setSettingsSaving(true);
    backend
      .runsSetSettings(next)
      .then(setSettings, (e) => useToasts.getState().push(`Couldn't save the limits: ${messageOf(e)}`))
      .finally(() => {
        saving.current = false;
        setSettingsSaving(false);
      });
  };

  const finished = useMemo(() => runs.filter(cleanable), [runs]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const ids = finished.map((r) => r.id).join();
  useEffect(() => {
    let live = true;
    for (const id of ids ? ids.split(",") : []) {
      backend?.runsDisk(id).then((n) => live && setSizes((s) => ({ ...s, [id]: n })), () => {});
    }
    return () => {
      live = false;
    };
  }, [backend, ids]);
  const known = finished.filter((r) => r.id in sizes);
  const offer = bulkCleanup(runs, Date.now(), known.length === finished.length ? known.reduce((sum, r) => sum + sizes[r.id], 0) : null);
  const [cleaning, setCleaning] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const cleanAll = async () => {
    if (!offer) return;
    setCleaning(true);
    const { removed, refused } = await useRuns.getState().cleanupAll(offer.runs.map((r) => r.id));
    setCleaning(false);
    setReport(cleanupReport(removed, refused));
  };
  const cleanup = offer ? { count: offer.runs.length, reason: offer.reason, report, busy: cleaning } : report ? { count: 0, reason: "", report, busy: false } : null;
  return <AgentsSettingsView runs={runs} stopping={stopping} keepRunning={keepRunning ?? (stoppable(runs).length || null)} settings={settings} settingsSaving={settingsSaving} cleanup={cleanup} onSettings={save} onCleanup={() => void cleanAll()} onStopAll={() => void useRuns.getState().stopAll()} onClose={() => useRuns.getState().closeSheet()} />;
}

/** Whichever sheet the Agents feature has open over the screen, and the keys that go with it. */
export function AgentSheets() {
  const sheet = useRuns((s) => s.sheet);
  const runSheetOpen = sheet !== null;

  // Closing a sheet that browsed from run to run has lost its opener; the run it ended on is the next best place.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !runSheetOpen && (!document.activeElement || document.activeElement === document.body)) {
      const id = useRuns.getState().selectedId;
      document.getElementById(id ? agentId(id) : "")?.focus({ preventScroll: true });
    }
    wasOpen.current = runSheetOpen;
  }, [runSheetOpen]);

  useEffect(() => {
    if (!runSheetOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      const store = useRuns.getState();
      const action = sheetKey(ev.key, { typing: typing(ev.target), modifier: ev.metaKey || ev.ctrlKey || ev.altKey, pickerOpen: pickerOpen(), browsing: store.sheet?.type === "run" });
      if (!action) return;
      ev.preventDefault();
      if (action === "close") store.closeSheet();
      else store.browse(action === "next" ? 1 : -1);
    };
    // Captured so the ticket peek behind the sheet doesn't also close on the same key.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runSheetOpen]);

  return sheet?.type === "run" ? <RunSheet key={sheet.id} id={sheet.id} /> : sheet?.type === "safety" ? <Settings /> : null;
}
