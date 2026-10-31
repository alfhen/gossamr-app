import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Backend } from "../backend/types";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";
import { GH_LOGIN_COMMAND, safeGithubUrl, splitLinks } from "../lib/githubUrl";
import type { GhAccount, GhAccounts } from "../types";
import { useWorkspace } from "../workspaceStore";
import { isSignedOut } from "./connectionsLogic";
import { useConnectionsUi } from "./connectionsUi";
import { openOnGithub, refreshAfterGithubChange, useGithubUi } from "./githubUi";
import { messageOf, useToasts } from "./toasts";

/** Message text where an address, such as the single sign-on page GitHub names, can be opened. */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.url && safeGithubUrl(part.text) ? (
          <button key={i} type="button" onClick={() => openOnGithub(part.text)} className="font-semibold underline [overflow-wrap:anywhere]">
            {part.text}
          </button>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export interface ConnectGithubViewProps {
  /** Null while `gh` is being asked. */
  found: GhAccounts | null;
  /** Logins (lower case) that already have a GitHub connection. */
  connected: string[];
  /** The connected logins (lower case) that GitHub no longer accepts. */
  signedOut: string[];
  /** The login being connected. */
  connecting: string | null;
  error: string | null;
  copied: boolean;
  onConnect(login: string): void;
  onCopy(command: string): void;
  onOpenTerminal(): void;
  onCheck(): void;
  onClose(): void;
}

function Command({ command, copied, terminal, onCopy, onOpenTerminal }: { command: string; copied: boolean; terminal: boolean } & Pick<ConnectGithubViewProps, "onCopy" | "onOpenTerminal">) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="selectable rounded bg-ws-sel px-1.5 py-0.5 font-mono text-xs">{command}</code>
      <Button size="sm" onClick={() => onCopy(command)}>
        {copied ? "Copied" : "Copy"}
      </Button>
      {terminal && (
        <Button size="sm" onClick={onOpenTerminal}>
          Open Terminal
        </Button>
      )}
    </div>
  );
}

function AccountRow({ account, connected, signedOut, busy, onConnect }: { account: GhAccount; connected: boolean; signedOut: boolean; busy: boolean; onConnect(): void }) {
  const note = signedOut ? (account.usable ? "Signed out" : "Signed out. gh's token was refused too. Use Another account.") : connected ? "Connected" : !account.usable ? "GitHub refused its token. Sign in again." : account.active ? "Active in gh" : "";
  const action = signedOut ? "Sign in again" : "Connect";
  return (
    <li className="flex items-center gap-3 border-b border-ws-sep py-2 last:border-b-0">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{account.login}</span>
        {note && <span className="ml-2 text-sm text-ws-ink3">{note}</span>}
      </span>
      {(!connected || signedOut) && (
        <Button variant="plain" size="sm" aria-label={`${action} ${signedOut ? "as " : ""}${account.login}`} disabled={!account.usable || busy} onClick={onConnect}>
          {busy ? "Connecting…" : action}
        </Button>
      )}
    </li>
  );
}

export function ConnectGithubView(p: ConnectGithubViewProps) {
  const { found } = p;
  const listed = found !== null && found.accounts.length > 0;
  return (
    <div className="grid gap-3.5">
      <div>
        <h2 className="font-display m-0 text-lg font-semibold">Connect GitHub</h2>
        <p className="mt-1 mb-0 text-ws-ink2">Pick an account gh is signed in as. Agents clone and push as the account gh has active.</p>
      </div>
      {!found && (
        <p role="status" className="m-0 text-ws-ink3">
          Asking gh…
        </p>
      )}
      {listed && (
        <ul aria-label="Accounts gh knows" className="m-0 list-none border-y border-ws-sep p-0">
          {found.accounts.map((a) => (
            <AccountRow key={a.login} account={a} connected={p.connected.includes(a.login.toLowerCase())} signedOut={p.signedOut.includes(a.login.toLowerCase())} busy={p.connecting === a.login} onConnect={() => p.onConnect(a.login)} />
          ))}
        </ul>
      )}
      {found && !listed && (
        <div className="grid gap-2">
          <p className="m-0 text-ws-ink2">{found.message}</p>
          {found.fix && <Command command={found.fix} copied={p.copied} terminal={found.fix === GH_LOGIN_COMMAND} onCopy={p.onCopy} onOpenTerminal={p.onOpenTerminal} />}
        </div>
      )}
      {p.error && (
        <p role="alert" className="m-0 text-sm text-ws-blocked [overflow-wrap:anywhere]">
          <LinkedText text={p.error} />
        </p>
      )}
      {listed && (
        <div className="grid gap-2 border-t border-ws-sep pt-3">
          <h3 className="m-0 text-sm font-semibold">Another account</h3>
          <p className="m-0 text-sm text-ws-ink2">Run this in Terminal, then check again.</p>
          <Command command={GH_LOGIN_COMMAND} copied={p.copied} terminal onCopy={p.onCopy} onOpenTerminal={p.onOpenTerminal} />
        </div>
      )}
      <div className="flex justify-between gap-2">
        <Button variant="quiet" size="lg" disabled={!found} onClick={p.onCheck}>
          {found && !listed && found.fix ? "I've run it, check again" : "Check again"}
        </Button>
        <Button variant="primary" size="lg" disabled={p.connecting !== null} onClick={p.onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function ConnectFrame({ children, onClose, label = "Connect GitHub" }: { children: ReactNode; onClose(): void; label?: string }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const at = document.activeElement;
    if (!sheet.current?.contains(at)) sheet.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 pt-[10vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className="ws-pop ws-sheet mb-8 w-[min(520px,92vw)] p-5 text-ws-ink outline-none">
        {children}
      </div>
    </div>
  );
}

function ConnectFlow({ backend, onClose }: { backend: Backend; onClose(): void }) {
  const connections = useWorkspace((s) => s.connections);
  const [found, setFound] = useState<GhAccounts | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const asked = useRef(0);

  const check = () => {
    const mine = ++asked.current;
    setFound(null);
    setError(null);
    backend.githubAccounts().then(
      (accounts) => mine === asked.current && setFound(accounts),
      (e) => mine === asked.current && setFound({ installed: true, accounts: [], message: `Couldn't ask gh: ${messageOf(e)}`, fix: null }),
    );
  };
  useEffect(() => {
    check();
    return () => void asked.current++;
  }, [backend]);

  const connect = async (login: string) => {
    setConnecting(login);
    setError(null);
    try {
      const connection = await backend.githubImportGhToken(login);
      useToasts.getState().push(`Connected to GitHub as ${connection.workspace}.`, "info");
      await refreshAfterGithubChange();
      useConnectionsUi.getState().select(connection.id);
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setConnecting(null);
    }
  };

  const copy = (command: string) => {
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => useToasts.getState().push("Couldn't copy it. Select it and copy by hand."),
    );
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented || connecting) return;
      ev.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connecting, onClose]);

  const github = connections.filter((c) => c.kind === "github");
  return (
    <ConnectFrame onClose={() => connecting === null && onClose()}>
      <ConnectGithubView
        found={found}
        connected={github.map((c) => c.workspace.toLowerCase())}
        signedOut={github.filter(isSignedOut).map((c) => c.workspace.toLowerCase())}
        connecting={connecting}
        error={error}
        copied={copied}
        onConnect={(login) => void connect(login)}
        onCopy={copy}
        onOpenTerminal={() => backend.githubOpenLogin().catch((e) => setError(`Couldn't open Terminal: ${messageOf(e)}`))}
        onCheck={check}
        onClose={onClose}
      />
    </ConnectFrame>
  );
}

/** The sheet opened from Settings, the palette or a ticket's Development section. */
export function ConnectGithubDialog() {
  const open = useGithubUi((s) => s.connectOpen);
  const close = useGithubUi((s) => s.closeConnect);
  const backend = useBackend();
  const ready = useWorkspace((s) => s.status === "ready");
  if (!open || !backend || !ready) return null;
  return <ConnectFlow backend={backend} onClose={close} />;
}
