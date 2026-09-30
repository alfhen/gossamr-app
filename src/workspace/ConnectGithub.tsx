import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { Backend } from "../backend/types";
import { useBackend } from "../backend/useBackend";
import { CLASSIC_TOKEN_URL, FINE_GRAINED_TOKEN_URL, safeGithubUrl } from "../lib/githubUrl";
import type { DeviceStart, GithubSignInOptions } from "../types";
import { useWorkspace } from "../workspaceStore";
import { availableMethods, connectReducer, countdown, splitLinks, START, type ConnectMethod, type ConnectState } from "./connectFlow";
import { openOnGithub, refreshAfterGithubChange, useGithubUi } from "./githubUi";
import { useTabs } from "./tabsStore";
import { messageOf, useToasts } from "./toasts";

const button = "rounded-lg px-3 py-1.5 font-semibold disabled:opacity-45";
const primary = `${button} bg-ws-accent text-white`;
const quiet = `${button} text-ws-ink2 hover:bg-ws-hover`;

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

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="m-0 rounded-lg border border-ws-blocked bg-ws-blocked-soft px-3 py-2 text-ws-blocked [overflow-wrap:anywhere]">
      <LinkedText text={message} />
    </p>
  );
}

function BackButton({ onClick, disabled }: { onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="justify-self-start text-sm text-ws-ink2 underline disabled:opacity-45">
      ← Other ways to connect
    </button>
  );
}

export interface ConnectViewProps {
  state: ConnectState;
  /** Null while the options are still being read. */
  options: GithubSignInOptions | null;
  token: string;
  now: number;
  copied: boolean;
  onToken(token: string): void;
  onPick(method: ConnectMethod): void;
  onSubmit(): void;
  onBack(): void;
  onRetry(): void;
  onCopy(code: string): void;
  onOpen(url: string): void;
  onClose(): void;
  onManage(): void;
}

function Choose({ options, onPick }: Pick<ConnectViewProps, "options" | "onPick">) {
  if (!options) return <p role="status" className="m-0 text-ws-ink3">Checking what is available…</p>;
  return (
    <ul aria-label="Ways to connect" className="m-0 grid list-none gap-2 p-0">
      {availableMethods(options).map((m) => (
        <li key={m.method}>
          <button type="button" onClick={() => onPick(m.method)} className="grid w-full gap-0.5 rounded-xl border border-ws-sep2 px-3.5 py-2.5 text-left hover:border-ws-accent hover:bg-ws-hover">
            <span className="font-semibold">{m.title}</span>
            <span className="text-sm text-ws-ink3">{m.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TokenStep({ state, token, onToken, onSubmit, onBack, onOpen }: Pick<ConnectViewProps, "token" | "onToken" | "onSubmit" | "onBack" | "onOpen"> & { state: Extract<ConnectState, { step: "token" }> }) {
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (token.trim() && !state.busy) onSubmit();
      }}
      className="grid gap-3"
    >
      <BackButton onClick={onBack} disabled={state.busy} />
      <div className="grid gap-1 text-sm text-ws-ink2">
        <p className="m-0">
          <b className="font-semibold text-ws-ink">Classic token:</b> tick <code>repo</code>, <code>read:org</code> and <code>notifications</code>.
        </p>
        <p className="m-0">
          <b className="font-semibold text-ws-ink">Fine-grained token:</b> read-only access to Contents, Pull requests and Metadata.
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <button type="button" onClick={() => onOpen(CLASSIC_TOKEN_URL)} className="text-ws-accent underline">
          Create a classic token
        </button>
        <button type="button" onClick={() => onOpen(FINE_GRAINED_TOKEN_URL)} className="text-ws-accent underline">
          Create a fine-grained token
        </button>
      </div>
      <label className="grid gap-1 text-sm font-semibold">
        Personal access token
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={token}
          disabled={state.busy}
          onChange={(ev) => onToken(ev.target.value)}
          placeholder="ghp_… or github_pat_…"
          className="rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 font-mono font-normal outline-none placeholder:text-ws-ink3 focus:border-ws-accent"
        />
      </label>
      <p className="m-0 text-sm text-ws-ink3">The token stays in your system keychain. It is sent only to GitHub, and Gossamr only reads with it.</p>
      {state.error && <ErrorLine message={state.error} />}
      <div className="flex justify-end">
        <button type="submit" disabled={!token.trim() || state.busy} className={primary}>
          {state.busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function CliStep({ state, onSubmit, onBack }: Pick<ConnectViewProps, "onSubmit" | "onBack"> & { state: Extract<ConnectState, { step: "cli" }> }) {
  return (
    <div className="grid gap-3">
      <BackButton onClick={onBack} disabled={state.busy} />
      <p className="m-0 text-ws-ink2">
        This runs <code>gh auth token</code> once, when you click the button, and connects with the token it prints. Nothing else is read from the GitHub CLI.
      </p>
      {state.error && <ErrorLine message={state.error} />}
      <div className="flex justify-end">
        <button type="button" disabled={state.busy} onClick={onSubmit} className={primary}>
          {state.busy ? "Connecting…" : "Use my GitHub CLI login"}
        </button>
      </div>
    </div>
  );
}

export function DeviceCode({ code, copied, onCopy, onOpen }: { code: DeviceStart; copied: boolean; onCopy(code: string): void; onOpen(url: string): void }) {
  const host = (() => {
    try {
      const u = new URL(code.verificationUri);
      return `${u.host}${u.pathname}`;
    } catch {
      return code.verificationUri;
    }
  })();
  return (
    <div className="grid gap-2.5 rounded-xl border border-ws-sep2 bg-ws-bar p-3.5">
      <span className="text-sm text-ws-ink3">Your code</span>
      <div className="flex flex-wrap items-center gap-3">
        <code aria-label={`Code ${code.userCode}`} className="selectable text-[28px] leading-none font-bold tracking-[0.12em]">
          {code.userCode}
        </code>
        <button type="button" onClick={() => onCopy(code.userCode)} className="rounded-md border border-ws-sep2 px-2.5 py-1 text-sm font-semibold hover:bg-ws-hover">
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={() => onOpen(code.verificationUri)} className="rounded-md bg-ws-accent px-2.5 py-1 font-semibold text-white">
          Open {host}
        </button>
        <span className="text-ws-ink3">and enter the code there.</span>
      </div>
    </div>
  );
}

function DeviceStep({ state, now, copied, onCopy, onOpen, onBack, onRetry }: Pick<ConnectViewProps, "now" | "copied" | "onCopy" | "onOpen" | "onBack" | "onRetry"> & { state: Extract<ConnectState, { step: "device" }> }) {
  if (state.phase === "starting") {
    return (
      <div className="grid gap-3">
        <p role="status" className="m-0 text-ws-ink3">Asking GitHub for a code…</p>
        <div className="flex justify-end">
          <button type="button" onClick={onBack} className={quiet}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (state.phase === "waiting" && state.code) {
    return (
      <div className="grid gap-3">
        <DeviceCode code={state.code} copied={copied} onCopy={onCopy} onOpen={onOpen} />
        <p role="status" className="m-0 flex items-center gap-2 text-ws-ink2">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-ws-accent" />
          Waiting for you to authorise in the browser…
          {state.expiresAt !== null && <span className="ml-auto text-ws-ink3">expires in {countdown(state.expiresAt, now)}</span>}
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onBack} className={quiet}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const what =
    state.phase === "expired" ? "The code expired before it was entered." : state.phase === "denied" ? "GitHub said the request was denied, so nothing was connected." : "Signing in didn't finish.";
  return (
    <div className="grid gap-3">
      <p role="alert" className="m-0 rounded-lg border border-ws-blocked bg-ws-blocked-soft px-3 py-2 text-ws-blocked [overflow-wrap:anywhere]">
        {what}
        {state.phase === "failed" && state.error && (
          <>
            {" "}
            <LinkedText text={state.error} />
          </>
        )}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={quiet}>
          Other ways
        </button>
        <button type="button" onClick={onRetry} className={primary}>
          {state.phase === "expired" ? "Get a new code" : "Try again"}
        </button>
      </div>
    </div>
  );
}

const SUBTITLE: Record<ConnectState["step"], string> = {
  choose: "Gossamr reads your pull requests, branches and commits to show the code behind each ticket. It is read-only: it never comments, merges or pushes.",
  token: "",
  cli: "",
  device: "",
  connected: "",
};

export function ConnectView(p: ConnectViewProps) {
  const { state } = p;
  return (
    <div className="grid gap-3.5">
      <div>
        <h2 className="m-0 text-lg font-semibold">{state.step === "connected" ? `Connected as ${state.connection.workspace}` : "Connect GitHub"}</h2>
        {SUBTITLE[state.step] && <p className="mt-1 mb-0 text-ws-ink2">{SUBTITLE[state.step]}</p>}
      </div>
      {state.step === "choose" && <Choose options={p.options} onPick={p.onPick} />}
      {state.step === "token" && <TokenStep state={state} token={p.token} onToken={p.onToken} onSubmit={p.onSubmit} onBack={p.onBack} onOpen={p.onOpen} />}
      {state.step === "cli" && <CliStep state={state} onSubmit={p.onSubmit} onBack={p.onBack} />}
      {state.step === "device" && <DeviceStep state={state} now={p.now} copied={p.copied} onCopy={p.onCopy} onOpen={p.onOpen} onBack={p.onBack} onRetry={p.onRetry} />}
      {state.step === "connected" && (
        <div className="grid gap-3">
          <p className="m-0 text-ws-ink2">Pull requests that name your tickets will show up in the Development section of each ticket once the first sync finishes.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={p.onManage} className={quiet}>
              Manage repositories
            </button>
            <button type="button" onClick={p.onClose} className={primary}>
              Done
            </button>
          </div>
        </div>
      )}
      {state.step === "choose" && (
        <div className="flex justify-end">
          <button type="button" onClick={p.onClose} className={quiet}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function ConnectFrame({ children, onClose }: { children: ReactNode; onClose(): void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 pt-[10vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Connect GitHub" className="ws-pop mb-8 w-[min(520px,92vw)] rounded-[14px] border border-ws-sep2 bg-ws-win p-5 text-ws-ink shadow-ws-pop">
        {children}
      </div>
    </div>
  );
}

function ConnectFlow({ backend, onClose }: { backend: Backend; onClose(): void }) {
  const [state, dispatch] = useReducer(connectReducer, START);
  const [options, setOptions] = useState<GithubSignInOptions | null>(null);
  const [token, setToken] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    let current = true;
    backend.githubSignInOptions().then(
      (o) => current && setOptions(o),
      () => current && setOptions({ token: true, ghCli: false, deviceFlow: false }),
    );
    return () => {
      current = false;
      attempt.current++;
    };
  }, [backend]);

  const failed = (e: unknown) => {
    const message = messageOf(e);
    dispatch({ type: "fail", message });
    useToasts.getState().push(`Couldn't connect GitHub: ${message}`);
  };

  const succeeded = async (connection: Awaited<ReturnType<Backend["githubConnectToken"]>>) => {
    setToken("");
    dispatch({ type: "connected", connection });
    useToasts.getState().push(`Connected to GitHub as ${connection.workspace}.`, "info");
    await refreshAfterGithubChange();
  };

  const device = state.step === "device" ? state.phase : null;
  useEffect(() => {
    if (device !== "starting") return;
    const mine = ++attempt.current;
    const stale = () => mine !== attempt.current;
    (async () => {
      let code: DeviceStart;
      try {
        code = await backend.githubDeviceStart();
      } catch (e) {
        if (!stale()) failed(e);
        return;
      }
      if (stale()) return;
      dispatch({ type: "deviceCode", code, now: Date.now() });
      try {
        const connection = await backend.githubDevicePoll();
        if (!stale()) await succeeded(connection);
      } catch (e) {
        if (stale()) return;
        const message = messageOf(e);
        dispatch({ type: "deviceEnd", message });
        useToasts.getState().push(`GitHub sign-in stopped: ${message}`);
      }
    })();
  }, [device, backend]);

  useEffect(() => {
    if (device !== "waiting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [device]);

  const expiresAt = state.step === "device" ? state.expiresAt : null;
  useEffect(() => {
    if (device === "waiting" && expiresAt !== null && now >= expiresAt + 5000) {
      attempt.current++;
      dispatch({ type: "deviceEnd", message: "the code expired before it was entered" });
    }
  }, [now, device, expiresAt]);

  const submit = async () => {
    if (state.step !== "token" && state.step !== "cli") return;
    const mine = ++attempt.current;
    dispatch({ type: "submit" });
    try {
      const connection = state.step === "token" ? await backend.githubConnectToken(token.trim()) : await backend.githubImportGhToken();
      if (mine === attempt.current) await succeeded(connection);
    } catch (e) {
      if (mine === attempt.current) failed(e);
    }
  };

  const copy = (code: string) => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => useToasts.getState().push("Couldn't copy the code. Select it and copy it by hand."),
    );
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      if (state.step === "token" || state.step === "cli") {
        if (!state.busy) onClose();
      } else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  return (
    <ConnectView
      state={state}
      options={options}
      token={token}
      now={now}
      copied={copied}
      onToken={setToken}
      onPick={(method) => dispatch({ type: "pick", method })}
      onSubmit={() => void submit()}
      onBack={() => {
        attempt.current++;
        setToken("");
        dispatch({ type: "back" });
      }}
      onRetry={() => dispatch({ type: "retry" })}
      onCopy={copy}
      onOpen={(url) => void openOnGithub(url)}
      onClose={onClose}
      onManage={() => {
        onClose();
        useTabs.getState().openSettings("watching");
      }}
    />
  );
}

/** The connect flow, opened from Settings, the palette or a ticket's Development section. */
export function ConnectGithubDialog() {
  const open = useGithubUi((s) => s.connectOpen);
  const close = useGithubUi((s) => s.closeConnect);
  const backend = useBackend();
  const ready = useWorkspace((s) => s.status === "ready");
  if (!open || !backend || !ready) return null;
  return (
    <ConnectFrame onClose={close}>
      <ConnectFlow backend={backend} onClose={close} />
    </ConnectFrame>
  );
}
