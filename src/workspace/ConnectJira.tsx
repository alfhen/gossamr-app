import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { announceSignedOut } from "../accountEvents";
import { auth, type AuthStatus, type TokenSignIn } from "../backend/auth";
import { MockBackend } from "../backend/mock";
import type { Backend } from "../backend/types";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";
import { CREATE_TOKEN_URL, EXPIRY_WARNING_DAYS, JIRA_SCOPES, TOKEN_PAGE_URL, defaultExpiry } from "../lib/jiraToken";
import { useWorkspace } from "../workspaceStore";
import { ConnectFrame } from "./ConnectGithub";
import { useJiraUi } from "./jiraUi";
import { messageOf, useToasts } from "./toasts";

const FIELD = "rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 font-normal outline-none placeholder:text-ws-ink3 focus:border-ws-accent";

export type JiraConnectApi = Pick<Backend, "jiraCloudId" | "jiraConnect">;

/** On the desktop, the sample workspace's backend is a mock that takes any token, so a sign-in from it goes to the real app. */
export function signInApi(backend: Backend): Pick<Backend, "jiraStatus" | "jiraCloudId" | "jiraConnect"> {
  return isTauri() && backend instanceof MockBackend ? { jiraStatus: auth.status, jiraCloudId: auth.cloudId, jiraConnect: auth.connect } : backend;
}

/** `found` names the site it was for, so an answer for a site since edited is never used. `failed` is a site that couldn't be reached. */
export type SiteLookup =
  | { state: "idle" }
  | { state: "looking" }
  | { state: "found"; cloudId: string; site: string }
  | { state: "missing" }
  | { state: "failed"; message: string };

export interface JiraFormValues {
  site: string;
  cloudId: string;
  email: string;
  token: string;
  expiresOn: string;
}

/** What to send, or null while a field is empty. A cloud id the site gave for this site wins over one typed. */
export function signInFrom(values: JiraFormValues, lookup: SiteLookup): TokenSignIn | null {
  const { site, email, token, expiresOn } = values;
  if (![site, email, token, expiresOn].every((v) => v.trim())) return null;
  const cloudId = lookup.state === "found" && lookup.site === site.trim() ? lookup.cloudId : values.cloudId.trim();
  return { site: site.trim(), email: email.trim(), token: token.trim(), expiresOn, ...(cloudId ? { cloudId } : {}) };
}

export interface ConnectJiraViewProps {
  values: JiraFormValues;
  lookup: SiteLookup;
  busy: boolean;
  error: string | null;
  scopesShown: boolean;
  copied: boolean;
  onChange(patch: Partial<JiraFormValues>): void;
  onLookup(): void;
  onCreateToken(): void;
  onToggleScopes(): void;
  onCopyScopes(): void;
  onOpenPlainPage(): void;
  onSubmit(): void;
  onCancel?(): void;
}

export function ConnectJiraView(p: ConnectJiraViewProps) {
  const { values, lookup } = p;
  const ready = signInFrom(values, lookup) !== null;
  return (
    <form
      aria-label="Connect Jira"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (ready && !p.busy) p.onSubmit();
      }}
      className="grid gap-4"
    >
      <div className="grid gap-1">
        <label className="grid gap-1 text-sm font-semibold">
          Your Jira site
          <input
            autoFocus
            value={values.site}
            disabled={p.busy}
            onChange={(ev) => p.onChange({ site: ev.target.value })}
            onBlur={p.onLookup}
            placeholder="acme.atlassian.net"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={FIELD}
          />
        </label>
        {lookup.state === "looking" && <p role="status" className="m-0 text-sm text-ws-ink3">Looking up the site…</p>}
        {lookup.state === "missing" && <p className="m-0 text-sm text-ws-ink3">Gossamr couldn't look up this site's cloud id. Ask your Jira admin for it and enter it below.</p>}
        {lookup.state === "failed" && (
          <p role="alert" className="selectable m-0 text-sm text-ws-blocked [overflow-wrap:anywhere]">
            {lookup.message}
          </p>
        )}
      </div>
      {lookup.state === "missing" && (
        <label className="grid gap-1 text-sm font-semibold">
          Cloud id
          <input value={values.cloudId} disabled={p.busy} onChange={(ev) => p.onChange({ cloudId: ev.target.value })} autoComplete="off" spellCheck={false} className={`${FIELD} font-mono`} />
        </label>
      )}

      <div className="grid gap-2 border-t border-ws-sep pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={p.onCreateToken}>Create token</Button>
          <p className="m-0 min-w-0 flex-1 text-sm text-ws-ink2">Atlassian opens with the scopes and the longest expiry filled in. Press Create there, then copy the token.</p>
        </div>
        <div>
          <Button variant="quiet" size="sm" aria-expanded={p.scopesShown} onClick={p.onToggleScopes}>
            The page didn't fill in
          </Button>
        </div>
        {p.scopesShown && (
          <div className="grid gap-2 text-sm text-ws-ink2">
            <p className="m-0">Open the plain token page, choose Create API token with scopes, pick Jira, and tick:</p>
            <p className="selectable m-0 font-mono text-xs">{JIRA_SCOPES.join(" ")}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={p.onCopyScopes}>
                {p.copied ? "Copied" : "Copy scopes"}
              </Button>
              <Button size="sm" variant="quiet" onClick={p.onOpenPlainPage}>
                Open the plain page
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-3 border-t border-ws-sep pt-4">
        <label className="grid gap-1 text-sm font-semibold">
          Your Atlassian email
          <input type="email" value={values.email} disabled={p.busy} onChange={(ev) => p.onChange({ email: ev.target.value })} placeholder="you@acme.com" autoComplete="off" spellCheck={false} className={FIELD} />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          API token
          <input type="password" value={values.token} disabled={p.busy} onChange={(ev) => p.onChange({ token: ev.target.value })} autoComplete="off" autoCapitalize="off" spellCheck={false} className={`${FIELD} font-mono`} />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Token expires
          <input type="date" value={values.expiresOn} disabled={p.busy} onChange={(ev) => p.onChange({ expiresOn: ev.target.value })} className={`${FIELD} justify-self-start`} />
          <span className="text-sm font-normal text-ws-ink3">
            Atlassian doesn't tell Gossamr, so use the date on the token page if it's sooner. Gossamr warns you {EXPIRY_WARNING_DAYS} days before this date.
          </span>
        </label>
      </div>

      <p className="m-0 text-sm text-ws-ink3">The token stays in your Keychain and goes only to Atlassian.</p>
      {p.error && (
        <p role="alert" className="selectable m-0 text-ws-blocked [overflow-wrap:anywhere]">
          {p.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {p.onCancel && (
          <Button variant="quiet" disabled={p.busy} onClick={p.onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" type="submit" disabled={!ready || p.busy}>
          {p.busy ? "Connecting…" : "Connect Jira"}
        </Button>
      </div>
    </form>
  );
}

async function open(url: string) {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** The Connect Jira form: looks the site up, opens Atlassian's token page and checks the token before it is kept. */
export function ConnectJiraForm({
  api,
  initial,
  instanceId,
  onConnected,
  onCancel,
  onBusy,
}: {
  api: JiraConnectApi;
  initial?: Partial<JiraFormValues>;
  instanceId?: string;
  onConnected(status: AuthStatus): void;
  onCancel?(): void;
  onBusy?(busy: boolean): void;
}) {
  const [values, setValues] = useState<JiraFormValues>({ site: "", cloudId: "", email: "", token: "", expiresOn: defaultExpiry(), ...initial });
  const [lookup, setLookup] = useState<SiteLookup>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopesShown, setScopesShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const site = useRef(values.site);
  const pending = useRef<{ site: string; answer: Promise<SiteLookup> } | null>(null);

  useEffect(() => () => onBusy?.(false), []);

  const working = (now: boolean) => {
    setBusy(now);
    onBusy?.(now);
  };

  const change = (patch: Partial<JiraFormValues>) => {
    if (patch.site === undefined) {
      setValues((v) => ({ ...v, ...patch }));
      return;
    }
    site.current = patch.site;
    pending.current = null;
    setLookup({ state: "idle" });
    setValues((v) => ({ ...v, ...patch, cloudId: "" }));
  };

  const lookUp = (): Promise<SiteLookup> => {
    const asked = site.current.trim();
    if (!asked) return Promise.resolve(lookup);
    if (lookup.state === "found" && lookup.site === asked) return Promise.resolve(lookup);
    if (pending.current?.site === asked) return pending.current.answer;
    setLookup({ state: "looking" });
    const answer = (async (): Promise<SiteLookup> => {
      let found: SiteLookup;
      try {
        const cloudId = await api.jiraCloudId(asked);
        found = cloudId ? { state: "found", cloudId, site: asked } : { state: "missing" };
      } catch (e) {
        found = { state: "failed", message: messageOf(e) };
      }
      if (site.current.trim() !== asked) return { state: "idle" };
      pending.current = null;
      setLookup(found);
      return found;
    })();
    pending.current = { site: asked, answer };
    return answer;
  };

  const submit = async () => {
    setError(null);
    working(true);
    try {
      const known = values.cloudId.trim() ? lookup : await lookUp();
      if (known.state === "failed" || known.state === "idle") return working(false);
      const input = signInFrom(values, known);
      if (!input) return working(false);
      if (!input.cloudId) {
        setError("Enter the site's cloud id.");
        return working(false);
      }
      onConnected(await api.jiraConnect(input, instanceId));
    } catch (e) {
      setError(messageOf(e));
      working(false);
    }
  };

  const copyScopes = () => {
    navigator.clipboard?.writeText(JIRA_SCOPES.join(" ")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => useToasts.getState().push("Couldn't copy the scopes. Select them and copy by hand."),
    );
  };

  return (
    <ConnectJiraView
      values={values}
      lookup={lookup}
      busy={busy}
      error={error}
      scopesShown={scopesShown}
      copied={copied}
      onChange={change}
      onLookup={() => void lookUp()}
      onCreateToken={() => void open(CREATE_TOKEN_URL)}
      onToggleScopes={() => setScopesShown((s) => !s)}
      onCopyScopes={copyScopes}
      onOpenPlainPage={() => void open(TOKEN_PAGE_URL)}
      onSubmit={() => void submit()}
      onCancel={onCancel}
    />
  );
}

/** The sheet that replaces the token, from Settings or the banner that says Jira turned the old one down. */
export function ConnectJiraDialog() {
  const shown = useJiraUi((s) => s.connectOpen);
  const close = useJiraUi((s) => s.closeConnect);
  const instanceId = useJiraUi((s) => s.connectInstanceId);
  const workspaceBackend = useBackend();
  const backend = useMemo(() => workspaceBackend && signInApi(workspaceBackend), [workspaceBackend]);
  const [current, setCurrent] = useState<AuthStatus | null>(null);
  const busy = useRef(false);
  const dismiss = () => {
    if (!busy.current) close();
  };
  useEffect(() => {
    if (!shown || !backend) return;
    let live = true;
    backend.jiraStatus().then((s) => live && setCurrent(s), () => {});
    return () => {
      live = false;
    };
  }, [shown, backend]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      if (!busy.current) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, close]);
  if (!shown || !backend) return null;

  const connected = (next: AuthStatus) => {
    busy.current = false;
    close();
    useToasts.getState().push(`Connected to Jira as ${next.me?.name ?? "you"}.`, "info");
    if (sameAccount(current, next)) {
      const ws = useWorkspace.getState();
      void Promise.all([ws.refreshConnections(true), ws.refresh()]);
    } else {
      announceSignedOut();
    }
  };

  return (
    <ConnectFrame label="Connect Jira" onClose={dismiss}>
      <div className="grid gap-4">
        <h2 className="font-display m-0 text-lg font-semibold">Connect Jira</h2>
        <ConnectJiraForm
          key={current?.site?.name ?? "new"}
          api={backend}
          instanceId={instanceId}
          initial={{ site: current?.site?.name ?? "", email: current?.email ?? "" }}
          onConnected={connected}
          onCancel={close}
          onBusy={(now) => (busy.current = now)}
        />
      </div>
    </ConnectFrame>
  );
}

/** A new token for the account already signed in keeps the workspace as it is; another site or account starts it over. */
export function sameAccount(before: AuthStatus | null, after: AuthStatus): boolean {
  return !!before?.site && before.site.cloudId === after.site?.cloudId && before.me?.accountId === after.me?.accountId;
}
