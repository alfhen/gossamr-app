import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { useBackend } from "../backend/useBackend";
import { AddModelField } from "../components/AddModelField";
import { Button } from "../components/Button";
import { MODEL_ID_RULE, validModelId } from "../lib/models";
import type { ModelOption } from "../types";

/** The models a provider instance offers, with Add model… for the ones its list lacks. */
export function ProviderModels({ instanceId }: { instanceId: string }) {
  const backend = useBackend();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useId();

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
    if (!validModelId(model)) return setProblem(MODEL_ID_RULE);
    if (!backend) return;
    setBusy(true);
    try {
      setModels(await backend.providerAddModel(instanceId, model));
      close();
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
        <AddModelField field={field} value={id} busy={busy} problem={problem} autoFocus onChange={(v) => (setId(v), setProblem(null))} onSubmit={submit} onCancel={close} />
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
