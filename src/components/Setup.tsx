import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthStatus } from "../backend/auth";
import type { FirstRunApi } from "../backend/firstRun";
import type { ProbeSnapshot } from "../types";
import { StatusLine } from "../workspace/Connections";
import { statusLine, type LineTone } from "../workspace/connectionsLogic";
import { ConnectJiraForm } from "../workspace/ConnectJira";
import { messageOf } from "../workspace/toasts";
import { Button } from "./Button";

const NOT_CHECKED: ProbeSnapshot = { installed: true, version: null, state: "error", account: null, message: "", fix: null, checkedAt: "" };

function Row({ badge, name, line, action, children }: { badge: string; name: string; line: { text: string; tone: LineTone }; action?: ReactNode; children?: ReactNode }) {
  return (
    <li aria-label={name} className="grid gap-2 border-b border-ws-sep py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-ws-sel text-xs font-bold text-ws-ink2">
          {badge}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{name}</span>
          <StatusLine line={line} />
        </span>
        {action}
      </div>
      {children && <div className="grid gap-2 pl-11">{children}</div>}
    </li>
  );
}

function GithubRow({ api }: { api: FirstRunApi }) {
  const [snapshot, setSnapshot] = useState<ProbeSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const live = useRef(true);

  const check = async () => {
    setChecking(true);
    setProblem(null);
    try {
      const found = await api.github();
      if (live.current) setSnapshot(found);
    } catch (e) {
      if (live.current) setSnapshot({ ...NOT_CHECKED, message: `Couldn't ask gh: ${messageOf(e)}` });
    } finally {
      if (live.current) setChecking(false);
    }
  };

  useEffect(() => {
    live.current = true;
    void check();
    return () => {
      live.current = false;
    };
  }, []);

  const copy = (command: string) =>
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setProblem("Couldn't copy it. Select it and copy by hand."),
    );

  const openTerminal = async () => {
    setProblem(null);
    setOpening(true);
    try {
      await api.openTerminal();
    } catch (e) {
      if (live.current) setProblem(`Couldn't open Terminal: ${messageOf(e)}`);
    } finally {
      if (live.current) setOpening(false);
    }
  };

  return <GithubRowView snapshot={snapshot} checking={checking} copied={copied} opening={opening} problem={problem} onCopy={(c) => void copy(c)} onOpenTerminal={() => void openTerminal()} onCheck={() => void check()} />;
}

export interface GithubRowViewProps {
  snapshot: ProbeSnapshot | null;
  checking: boolean;
  copied: boolean;
  opening?: boolean;
  problem: string | null;
  onCopy(command: string): void;
  onOpenTerminal(): void;
  onCheck(): void;
}

export function GithubRowView({ snapshot, checking, copied, opening = false, problem, onCopy, onOpenTerminal, onCheck }: GithubRowViewProps) {
  const line = statusLine({ kind: "github", account: "", status: snapshot, enabled: true }, checking);
  const ready = snapshot?.state === "ready";
  return (
    <Row badge="GH" name="GitHub" line={line}>
      {snapshot && !checking && (
        <>
          <p data-probe={snapshot.state} className="m-0 text-sm text-ws-ink2">
            {ready ? `${snapshot.message}. Agents use this account to clone and push.` : snapshot.message}
          </p>
          {snapshot.fix && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="selectable rounded bg-ws-sel px-1.5 py-0.5 font-mono text-xs">{snapshot.fix}</code>
              <Button size="sm" onClick={() => onCopy(snapshot.fix as string)}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" disabled={opening} onClick={onOpenTerminal}>
                Open Terminal
              </Button>
            </div>
          )}
          {problem && (
            <p role="status" className="m-0 text-sm text-ws-blocked">
              {problem}
            </p>
          )}
          {!ready && (
            <div>
              <Button variant="quiet" size="sm" onClick={onCheck}>
                {snapshot.fix ? "I've run it, check again" : "Check again"}
              </Button>
            </div>
          )}
        </>
      )}
    </Row>
  );
}

function JiraRow({ api, onSignedIn }: { api: FirstRunApi; onSignedIn: (s: AuthStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Row
      badge="JI"
      name="Jira"
      line={{ text: "Not connected", tone: "quiet" }}
      action={
        !open && (
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Connect Jira
          </Button>
        )
      }
    >
      {open && <ConnectJiraForm api={api} onConnected={onSignedIn} onCancel={() => setOpen(false)} />}
    </Row>
  );
}

export function Setup({ api, onSignedIn, onUseSampleData }: { api: FirstRunApi; onSignedIn: (s: AuthStatus) => void; onUseSampleData: () => void }) {
  return (
    <div data-tauri-drag-region className="grid h-full place-items-center overflow-auto bg-ws-win px-6 py-10 text-ws-ink">
      <div className="grid w-full max-w-[520px] gap-5">
        <div>
          <h1 className="font-display m-0 text-xl font-bold">Connect your accounts</h1>
          <p className="mt-1 mb-0 text-ws-ink2">Pip drafts and you approve. Nothing reaches Jira or GitHub until you say so.</p>
        </div>
        <ul aria-label="Accounts" className="m-0 grid list-none border-y border-ws-sep p-0">
          <GithubRow api={api} />
          <JiraRow api={api} onSignedIn={onSignedIn} />
        </ul>
        <div>
          <Button variant="quiet" onClick={onUseSampleData}>
            Try it with sample data
          </Button>
        </div>
      </div>
    </div>
  );
}
