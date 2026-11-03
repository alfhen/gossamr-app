import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";
import { MODEL_ID_LIMIT, validModelId } from "../lib/models";
import type { ModelOption } from "../types";
import { useWorkspace } from "../workspaceStore";

const ID_RULE = `Use letters, digits and . _ - [ ], starting with a letter or digit, up to ${MODEL_ID_LIMIT} characters.`;

/** The models a provider instance offers, with Add model… for the ones its list lacks. */
export function ProviderModels({ instanceId }: { instanceId: string }) {
  const backend = useBackend();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setAdding(false);
    setId("");
    setProblem(null);
  }, []);
  useEffect(() => {
    close();
    if (!backend) return;
    let current = true;
    backend.providerModels(instanceId).then((list) => current && setModels(list), () => current && setModels([]));
    return () => {
      current = false;
    };
  }, [backend, instanceId, close]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const model = id.trim();
    if (!validModelId(model)) return setProblem(ID_RULE);
    if (!backend) return;
    setBusy(true);
    try {
      setModels(await backend.providerAddModel(instanceId, model));
      close();
      void useWorkspace.getState().refreshConnections();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="m-0">{models.map((m) => m.label).join(", ") || "No models listed"}</p>
      {adding ? (
        <form onSubmit={submit} className="grid gap-1">
          <label htmlFor={`model-id-${instanceId}`} className="text-sm text-ws-ink2">
            Model id
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={`model-id-${instanceId}`}
              value={id}
              disabled={busy}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(ev) => (setId(ev.target.value), setProblem(null))}
              className="min-w-0 flex-1 rounded-lg border border-ws-sep2 bg-ws-win px-2 py-1 font-mono text-sm outline-none focus:border-ws-accent"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !id.trim()}>
              Add
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
          {problem && (
            <p role="alert" className="m-0 text-sm text-ws-blocked">
              {problem}
            </p>
          )}
        </form>
      ) : (
        <div>
          <Button variant="quiet" size="sm" onClick={() => setAdding(true)}>
            Add model…
          </Button>
        </div>
      )}
    </>
  );
}
