import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../backend/types";
import type { CatalogEntry } from "../types";
import { messageOf } from "./toasts";
import { mergeEntries } from "./watchLogic";

const DEBOUNCE_MS = 250;

export interface Catalog {
  entries: CatalogEntry[];
  status: "loading" | "ready" | "error";
  error: string | null;
  /** The tracker couldn't be reached; the entries are what was listed before. */
  offline: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/** Pages through a connection's catalog, searching on the server as the query changes. */
export function useCatalog(backend: Backend | null, connectionId: string, query: string): Catalog {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [status, setStatus] = useState<Catalog["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    if (!backend) return;
    const mine = ++seq.current;
    setStatus("loading");
    const wait = first.current ? 0 : DEBOUNCE_MS;
    first.current = false;
    const timer = setTimeout(() => {
      backend.watchCatalog(connectionId, query.trim()).then(
        (page) => {
          if (mine !== seq.current) return;
          setEntries(page.containers);
          setNext(page.next);
          setOffline(page.offline);
          setError(null);
          setLoadingMore(false);
          setStatus("ready");
        },
        (e) => {
          if (mine !== seq.current) return;
          setError(messageOf(e));
          setStatus("error");
        },
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [backend, connectionId, query, attempt]);

  const loadMore = useCallback(() => {
    if (!backend || !next || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    backend.watchCatalog(connectionId, query.trim(), next).then(
      (page) => {
        if (mine !== seq.current) return;
        setEntries((have) => mergeEntries(have, page.containers));
        setNext(page.next);
        setOffline(page.offline);
        setLoadingMore(false);
      },
      (e) => {
        if (mine !== seq.current) return;
        setLoadingMore(false);
        setError(messageOf(e));
      },
    );
  }, [backend, connectionId, query, next, loadingMore]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { entries, status, error, offline, hasMore: next !== null, loadingMore, loadMore, retry };
}
