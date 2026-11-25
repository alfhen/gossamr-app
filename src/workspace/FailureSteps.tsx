import { useState } from "react";
import type { Run } from "../types";
import { Button, type ButtonProps } from "../components/Button";
import { PipGlyph } from "../components/PipGlyph";
import { Icon } from "./AgentIcons";
import type { FailureAct } from "./failureHelp";
import { refuserOf } from "./cleanupLogic";
import { useRuns } from "./runsStore";

const ACT_ICONS = { terminal: "term", install: "ext", trust: "shield", cleanup: "folder" } as const;

export interface FailureStepProps {
  run: Run;
  step: { label: string; act: FailureAct };
  primary: boolean;
  size: ButtonProps["size"];
  trusting?: boolean;
  onAct(act: FailureAct): void;
}

/** One step a failure offers. Clean up asks before it removes anything, and shows the refusal in its own words. */
export function FailureStep({ run, step, primary, size, trusting = false, onAct }: FailureStepProps) {
  if (step.act === "cleanup") return <CleanupStep run={run} label={step.label} primary={primary} size={size} />;
  return (
    <Button variant={primary ? "primary" : "secondary"} size={size} disabled={step.act === "trust" && trusting} onClick={(ev) => (ev.stopPropagation(), onAct(step.act))}>
      {step.act === "pip" ? <PipGlyph /> : <Icon name={ACT_ICONS[step.act]} />}
      {step.act === "trust" && trusting ? "Trusting…" : step.label}
    </Button>
  );
}

function CleanupStep({ run, label, primary, size }: { run: Run; label: string; primary: boolean; size: ButtonProps["size"] }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    const result = await useRuns.getState().cleanup(run.id);
    setBusy(false);
    setAsking(false);
    setRefused(result?.type === "refused" ? result.message : null);
  };
  const refusal = refused && (
    <p role="alert" data-tone="error" className="selectable m-0 basis-full text-sm whitespace-pre-wrap text-ws-danger [overflow-wrap:anywhere]">
      {refuserOf("git", null)} kept it: {refused}
    </p>
  );
  if (asking)
    return (
      <span
        role="group"
        aria-label="Clean up this run"
        data-esc-local
        className="inline-flex flex-wrap items-center gap-1.5"
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") (ev.stopPropagation(), setAsking(false));
        }}
      >
        <span className="text-ws-ink2">Remove the worktree?</span>
        <Button variant="danger" size={size} autoFocus disabled={busy} onClick={() => void confirm()}>
          {busy ? "Removing…" : "Yes, remove it"}
        </Button>
        <Button variant="quiet" size={size} disabled={busy} onClick={() => setAsking(false)}>
          Keep it
        </Button>
      </span>
    );
  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} size={size} onClick={(ev) => (ev.stopPropagation(), setRefused(null), setAsking(true))}>
        <Icon name="folder" />
        {label}
      </Button>
      {refusal}
    </>
  );
}
