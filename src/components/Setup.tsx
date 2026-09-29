import { useState } from "react";
import { auth, type AuthStatus } from "../backend/auth";

export function Setup({
  status,
  onSignedIn,
  onUseSampleData,
}: {
  status: AuthStatus;
  onSignedIn: (s: AuthStatus) => void;
  onUseSampleData: () => void;
}) {
  const [configured, setConfigured] = useState(status.configured);
  const [editing, setEditing] = useState(!status.configured);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "signin" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async <T,>(what: "save" | "signin", fn: () => Promise<T>) => {
    setBusy(what);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const s = await run("save", () => auth.saveApp(clientId, secret));
    if (s) {
      setConfigured(s.configured);
      setEditing(false);
      setSecret("");
    }
  };

  const signIn = async () => {
    const s = await run("signin", auth.signIn);
    if (s?.site) onSignedIn(s);
  };

  const input = "w-full rounded-md border border-field-border bg-field px-2.5 py-1.5 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft";
  const primary = "rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white disabled:opacity-45";

  return (
    <div data-tauri-drag-region className="grid h-full place-items-center overflow-auto bg-win px-6 py-10">
      <div className="grid w-full max-w-[520px] gap-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Connect Jira</h1>
          <p className="mt-1 text-ink-2">
            Gossamr signs in with your own Atlassian OAuth app, so it acts as you with your permissions. Tokens are kept in the macOS Keychain.
          </p>
        </div>

        <section className="grid gap-3">
          <h2 className="text-xs font-semibold tracking-wide text-ink-3 uppercase">1 · Register an OAuth app</h2>
          <ol className="selectable grid list-decimal gap-1.5 pl-5 text-ink-2">
            <li>
              Open <b className="text-ink">developer.atlassian.com/console/myapps</b> and create an <b className="text-ink">OAuth 2.0 integration</b>.
            </li>
            <li>
              Under <b className="text-ink">Permissions</b>, add Jira API with <code className="font-mono text-sm">{status.scopes.replace(" offline_access", "")}</code>.
            </li>
            <li>
              Under <b className="text-ink">Authorization</b>, set the callback URL to <code className="font-mono text-sm text-ink">{status.callbackUrl}</code>.
            </li>
            <li>Copy the client ID and secret from <b className="text-ink">Settings</b> below.</li>
          </ol>
          {editing ? (
            <form onSubmit={save} className="grid gap-2">
              <label className="grid gap-1">
                <span className="text-sm text-ink-2">Client ID</span>
                <input id="client-id" className={input} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-ink-2">Secret</span>
                <input id="client-secret" type="password" className={input} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              </label>
              <div className="flex gap-2">
                <button type="submit" className={primary} disabled={!clientId.trim() || !secret.trim() || busy !== null}>
                  {busy === "save" ? "Saving…" : "Save to Keychain"}
                </button>
                {configured && (
                  <button type="button" className="px-2 text-ink-2" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="flex items-center gap-2 text-ink-2">
              <span className="text-done">✓</span> App credentials saved in the Keychain.
              <button type="button" className="text-accent" onClick={() => setEditing(true)}>
                Replace
              </button>
            </div>
          )}
        </section>

        <section className="grid gap-3">
          <h2 className="text-xs font-semibold tracking-wide text-ink-3 uppercase">2 · Sign in</h2>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primary} disabled={!configured || busy !== null} onClick={() => void signIn()}>
              {busy === "signin" ? "Waiting for the browser…" : "Sign in with Atlassian"}
            </button>
            <button type="button" className="text-accent disabled:opacity-45" disabled={busy === "signin"} onClick={onUseSampleData}>
              Try it with sample data
            </button>
          </div>
          {busy === "signin" && <p className="text-sm text-ink-3">Approve access in the browser tab that just opened, then come back here.</p>}
        </section>

        {error && (
          <div role="alert" className="selectable rounded-md bg-blocked-bg px-3 py-2 text-blocked">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
