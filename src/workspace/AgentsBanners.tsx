import { useEffect, useRef, useState, type ReactNode } from "react";
import { browserDeps, copyText } from "../components/CodeBlock";
import type { RunsEnvironment } from "../types";
import { Icon, type IconName } from "./AgentIcons";
import { INSTALL_COMMAND } from "./failureHelp";
import { messageOf, useToasts } from "./toasts";

const TONES = {
  bad: { box: "border-ws-blocked/40 bg-ws-blocked-soft", head: "text-ws-blocked" },
} as const;

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover";

function Banner({ icon, title, children, actions }: { icon: IconName; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-[10px] border px-3.5 py-2.5 ${TONES.bad.box}`}>
      <Icon name={icon} className={`mt-px size-[18px] ${TONES.bad.head}`} />
      <div className="min-w-0 flex-1">
        <b className={`block font-semibold ${TONES.bad.head}`}>{title}</b>
        <p className="m-0 mt-px text-ws-ink2">{children}</p>
        {actions && <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

export function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await copyText(text, browserDeps());
    } catch (e) {
      useToasts.getState().push(`Couldn't copy: ${messageOf(e)}`);
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex max-w-full items-center gap-2 rounded-[7px] border border-ws-sep bg-ws-bar py-1 pr-1 pl-2.5 font-mono text-sm text-ws-ink">
      <span className="selectable min-w-0 flex-1 overflow-auto whitespace-nowrap">{text}</span>
      <button type="button" aria-label={`Copy ${text}`} onClick={() => void copy()} className={`${BUTTON} shrink-0 font-sans`}>
        <Icon name="copy" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export interface AgentsBannersProps {
  environment: RunsEnvironment | null;
  /** Why the runs could not be read, when they could not. */
  loadError: string | null;
  onCheckAgain(): void;
  onRetry(): void;
}

export function AgentsBanners({ environment, loadError, onCheckAgain, onRetry }: AgentsBannersProps) {
  const check = (
    <button type="button" onClick={onCheckAgain} className={BUTTON}>
      <Icon name="retry" />
      Check again
    </button>
  );
  return (
    <>
      {environment?.claude === "missing" && (
        <Banner
          icon="alert"
          title="Claude Code isn't installed on this Mac"
          actions={
            <>
              <CopyBox text={INSTALL_COMMAND} />
              {check}
            </>
          }
        >
          Agents are Claude Code sessions, so Gossamr needs the <code className="font-mono">claude</code> command. Nothing can start until it is installed. Runs already finished are unaffected.
        </Banner>
      )}
      {environment?.claude === "signedOut" && (
        <Banner
          icon="lock"
          title="Claude Code isn't signed in"
          actions={
            <>
              <CopyBox text="claude" />
              {check}
            </>
          }
        >
          Agents use your own Claude account. Run <code className="font-mono">claude</code> in Terminal and sign in with <code className="font-mono">/login</code>, then they can start. Runs already finished are unaffected.
        </Banner>
      )}
      {loadError && (
        <Banner
          icon="alert"
          title="Couldn't load your agents"
          actions={
            <button type="button" onClick={onRetry} className={BUTTON}>
              <Icon name="retry" />
              Retry
            </button>
          }
        >
          <span className="selectable [overflow-wrap:anywhere]">{loadError}</span>
        </Banner>
      )}
    </>
  );
}
