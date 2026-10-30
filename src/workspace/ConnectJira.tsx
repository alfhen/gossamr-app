import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { announceSignedOut } from "../accountEvents";
import { auth, type AuthStatus, type TokenSignIn } from "../backend/auth";
import { Button } from "../components/Button";
import { CREATE_TOKEN_URL, EXPIRY_WARNING_DAYS, JIRA_SCOPES, TOKEN_PAGE_URL, defaultExpiry } from "../lib/jiraToken";
import { useWorkspace } from "../workspaceStore";
import { ConnectFrame } from "./ConnectGithub";
import { useJiraUi } from "./jiraUi";
import { messageOf, useToasts } from "./toasts";

const FIELD = "rounded-lg border border-ws-sep2 bg-ws-win px-3 py-1.5 font-normal outline-none placeholder:text-ws-ink3 focus:border-ws-accent";

export type SiteLookup = { state: "idle" } | { state: "looking" } | { state: "found"; cloudId: string } | { state: "missing" };

export interface JiraFormValues {
  site: string;
  cloudId: string;
  email: string;
  token: string;
  expiresOn: string;
}

/** What to send, or null while a field is empty. A cloud id the site gave wins over one typed before it did. */
export function signInFrom(values: JiraFormValues, lookup: SiteLookup): TokenSignIn | null {
  const { site, email, token, expiresOn } = values;
  if (![site, email, token, expiresOn].every((v) => v.trim())) return null;
  const cloudId = lookup.state === "found" ? lookup.cloudId : values.cloudId.trim();
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
          <span className="text-sm font-normal text-ws-ink3">Atlassian doesn't tell Gossamr. It warns you {EXPIRY_WARNING_DAYS} days before this date.</span>
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
export function ConnectJiraForm({ initial, onConnected, onCancel }: { initial?: Partial<JiraFormValues>; onConnected(status: AuthStatus): void; onCancel?(): void }) {
  const [values, setValues] = useState<JiraFormValues>({ site: "", cloudId: "", email: "", token: "", expiresOn: defaultExpiry(), ...initial });
  const [lookup, setLookup] = useState<SiteLookup>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopesShown, setScopesShown] = useState(false);
  const [copied, setCopied] = useState(false);

  const change = (patch: Partial<JiraFormValues>) => {
    setValues((v) => ({ ...v, ...patch }));
    if (patch.site !== undefined) setLookup({ state: "idle" });
  };

  const lookUp = async (): Promise<SiteLookup> => {
    if (!values.site.trim() || lookup.state === "found" || lookup.state === "looking") return lookup;
    setLookup({ state: "looking" });
    let found: SiteLookup = { state: "missing" };
    try {
      const cloudId = await auth.cloudId(values.site);
      if (cloudId) found = { state: "found", cloudId };
    } catch (e) {
      setError(messageOf(e));
      found = { state: "idle" };
    }
    setLookup(found);
    return found;
  };

  const submit = async () => {
    setError(null);
    const known = lookup.state === "idle" && !values.cloudId.trim() ? await lookUp() : lookup;
    const input = signInFrom(values, known);
    if (!input) return;
    if (!input.cloudId) {
      setError("Enter the site's cloud id.");
      return;
    }
    setBusy(true);
    try {
      onConnected(await auth.connect(input));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
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
  const [current, setCurrent] = useState<AuthStatus | null>(null);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    auth.status().then((s) => live && setCurrent(s), () => {});
    return () => {
      live = false;
    };
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, close]);
  if (!shown) return null;

  const connected = (next: AuthStatus) => {
    close();
    useToasts.getState().push(`Connected to Jira as ${next.me?.name ?? "you"}.`, "info");
    const same = current?.site?.cloudId === next.site?.cloudId && current?.me?.accountId === next.me?.accountId;
    if (same) {
      const ws = useWorkspace.getState();
      void Promise.all([ws.refreshConnections(true), ws.refresh()]);
    } else {
      announceSignedOut();
    }
  };

  return (
    <ConnectFrame label="Connect Jira" onClose={close}>
      <div className="grid gap-4">
        <h2 className="font-display m-0 text-lg font-semibold">Connect Jira</h2>
        <ConnectJiraForm key={current?.site?.name ?? "new"} initial={{ site: current?.site?.name ?? "", email: current?.email ?? "" }} onConnected={connected} onCancel={close} />
      </div>
    </ConnectFrame>
  );
}
