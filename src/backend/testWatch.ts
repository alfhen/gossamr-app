import type { Backend } from "./types";

/** Watches every repository a connection lists, as a person who chose the whole catalog would have. */
export async function watchEveryRepo(backend: Pick<Backend, "watchCatalog" | "watchSetContainers">, connectionId: string) {
  const containerIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<Backend["watchCatalog"]>> = await backend.watchCatalog(connectionId, "", cursor);
    containerIds.push(...page.containers.filter((c) => !c.archived).map((c) => c.ref.externalId));
    cursor = page.next;
  } while (cursor);
  await backend.watchSetContainers(connectionId, containerIds.map((containerId) => ({ containerId, watched: true })));
}
