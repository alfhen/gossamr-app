import { useState } from "react";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";
import { Segmented } from "../components/Segmented";
import { nameProblem, NAME_LIMIT } from "../lib/connectionName";
import type { Driver } from "../lib/models";
import type { ConnectionInfo } from "../types";
import { useWorkspace } from "../workspaceStore";
import { ConnectFrame } from "./ConnectGithub";
import { useConnectionsUi } from "./connectionsUi";
import { accountOf, DRIVER_NAME, suggestedFolder, usualSetupOffered } from "./providerLogic";
import { useProviderUi } from "./providerUi";
import { messageOf, useToasts } from "./toasts";

const FIELD = "rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 font-normal outline-none placeholder:text-ws-ink3 focus:border-ws-accent";

type FolderChoice = "own" | "usual";

export interface ProviderFormValues {
  name: string;
  choice: FolderChoice;
  folder: string;
}

export interface ProviderFormProps {
  driver: Driver;
  values: ProviderFormValues;
  usualOffered: boolean;
  busy: boolean;
  error: string | null;
  onChange(patch: Partial<ProviderFormValues>): void;
  onSubmit(): void;
  onCancel(): void;
}

export function ProviderFormView({ driver, values, usualOffered, busy, error, onChange, onSubmit, onCancel }: ProviderFormProps) {
  const label = DRIVER_NAME[driver];
  const folderLabel = driver === "claude" ? "Config folder" : "Codex home";
  const problem = values.name.trim() ? nameProblem(values.name) : null;
  const ready = values.name.trim() !== "" && problem === null && (values.choice === "usual" || values.folder.trim() !== "");
  return (
    <form
      aria-label={`Add ${label}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (ready && !busy) onSubmit();
      }}
      className="grid gap-3.5"
    >
      <div>
        <h2 className="font-display m-0 text-lg font-semibold">Add {label}</h2>
        <p className="mt-1 mb-0 text-ws-ink2">Each {label} has its own {driver === "claude" ? "config folder" : "home folder"}, so its login, settings and history stay apart.</p>
      </div>
      <label className="grid gap-1 text-sm font-semibold">
        Name
        <input value={values.name} disabled={busy} autoFocus maxLength={NAME_LIMIT * 2} autoComplete="off" spellCheck={false} placeholder={`${label} work`} onChange={(ev) => onChange({ name: ev.target.value })} className={FIELD} />
        {problem && (
          <span role="status" className="font-normal text-ws-blocked">
            {problem}
          </span>
        )}
      </label>
      <div className="grid gap-2">
        {usualOffered && (
          <Segmented
            kind="radio"
            label={folderLabel}
            value={values.choice}
            onChange={(choice) => onChange({ choice })}
            options={[
              { value: "own", label: "Its own folder" },
              { value: "usual", label: "My usual setup" },
            ]}
          />
        )}
        {values.choice === "own" ? (
          <label className="grid gap-1 text-sm font-semibold">
            {folderLabel}
            <input value={values.folder} disabled={busy} autoComplete="off" spellCheck={false} placeholder={suggestedFolder(driver, `${label} work`)} onChange={(ev) => onChange({ folder: ev.target.value })} className={`${FIELD} font-mono text-sm`} />
            <span className="font-normal text-ws-ink3">Gossamr creates it if it doesn't exist.</span>
          </label>
        ) : (
          <p className="m-0 text-sm text-ws-ink3">Uses the login {label} already has on this Mac.</p>
        )}
      </div>
      <p className="m-0 text-sm text-ws-ink3">Gossamr runs each agent on the login you pick. It never switches between logins by itself.</p>
      {error && (
        <p role="alert" className="selectable m-0 text-ws-blocked [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? "Adding…" : `Add ${label}`}
        </Button>
      </div>
    </form>
  );
}

export interface SignInStepProps {
  row: ConnectionInfo | undefined;
  checking: boolean;
  copied: boolean;
  onCopy(command: string): void;
  onOpenTerminal(): void;
  onCheck(): void;
  onDone(): void;
}

export function SignInStepView({ row, checking, copied, onCopy, onOpenTerminal, onCheck, onDone }: SignInStepProps) {
  const label = DRIVER_NAME[row?.driver ?? "claude"];
  const status = row?.status ?? null;
  const account = row ? accountOf(row) : null;
  return (
    <div aria-label={`Sign in to ${row?.displayName ?? label}`} role="group" className="grid gap-3.5">
      <div>
        <h2 className="font-display m-0 text-lg font-semibold">{row?.displayName ?? label} is added</h2>
        {status?.state === "ready" ? (
          <p role="status" className="mt-1 mb-0 text-ws-ink">
            Authenticated · {account}
          </p>
        ) : (
          <p className="mt-1 mb-0 text-ws-ink2">{status?.state === "notSignedIn" ? `Sign in as this ${label}. Run this in Terminal, then check again.` : (status?.message ?? "Checking…")}</p>
        )}
      </div>
      {status?.state === "notSignedIn" && status.fix && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="selectable rounded bg-ws-sel px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere]">{status.fix}</code>
          <Button size="sm" onClick={() => onCopy(status.fix as string)}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" onClick={onOpenTerminal}>
            Open Terminal
          </Button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {status?.state !== "ready" && (
          <Button disabled={checking} onClick={onCheck}>
            I've run it, check again
          </Button>
        )}
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function AddProvider({ driver, onClose }: { driver: Driver; onClose(): void }) {
  const backend = useBackend();
  const connections = useWorkspace((s) => s.connections);
  const usualOffered = usualSetupOffered(connections, driver);
  const [values, setValues] = useState<ProviderFormValues>({ name: "", choice: "own", folder: "" });
  const [folderTyped, setFolderTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const change = (patch: Partial<ProviderFormValues>) => {
    if (patch.folder !== undefined) setFolderTyped(true);
    const follows = patch.name !== undefined && patch.folder === undefined && !folderTyped;
    setValues((v) => ({ ...v, ...patch, ...(follows ? { folder: suggestedFolder(driver, patch.name ?? "") } : {}) }));
  };

  const submit = async () => {
    if (!backend) return;
    setBusy(true);
    setError(null);
    try {
      const row = await backend.providerAdd(driver, values.name.trim(), values.choice === "own" ? values.folder.trim() : undefined);
      await useWorkspace.getState().refreshConnections();
      useConnectionsUi.getState().select(row.id);
      setAdded(row.instanceId);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const row = connections.find((c) => c.instanceId === added);
  const check = async () => {
    setChecking(true);
    try {
      await useWorkspace.getState().refreshConnections(true);
    } finally {
      setChecking(false);
    }
  };
  const copy = (command: string) =>
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => useToasts.getState().push("Couldn't copy it. Select it and copy by hand."),
    );
  const openTerminal = () => added && backend?.connectionOpenTerminal(added).catch((e) => useToasts.getState().push(`Couldn't open Terminal: ${messageOf(e)}`));

  return (
    <ConnectFrame label={`Add ${DRIVER_NAME[driver]}`} takesEscape onClose={() => !busy && onClose()}>
      {added === null ? (
        <ProviderFormView driver={driver} values={values} usualOffered={usualOffered} busy={busy} error={error} onChange={change} onSubmit={() => void submit()} onCancel={onClose} />
      ) : (
        <SignInStepView row={row} checking={checking} copied={copied} onCopy={(c) => void copy(c)} onOpenTerminal={() => void openTerminal()} onCheck={() => void check()} onDone={onClose} />
      )}
    </ConnectFrame>
  );
}

/** The sheet opened from + Add or the palette. */
export function AddProviderDialog() {
  const driver = useProviderUi((s) => s.adding);
  const close = useProviderUi((s) => s.closeAdd);
  const ready = useWorkspace((s) => s.status === "ready");
  if (!driver || !ready) return null;
  return <AddProvider key={driver} driver={driver} onClose={close} />;
}
