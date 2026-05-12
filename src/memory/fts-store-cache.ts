// Singleton FtsStore per workspace, closed on process exit.
// Shared by memory-search-tool (read path) and turn-fts-persistence (write path)
// to avoid two writers fighting over the same SQLite file.

import path from "node:path";
import { FtsStore } from "./fts-store.js";

const _stores = new Map<string, FtsStore>();

export function getOrOpenFtsStore(workspaceDir: string): FtsStore {
  const dbPath = path.join(workspaceDir, "state.db");
  let store = _stores.get(dbPath);
  if (!store) {
    store = FtsStore.open(dbPath);
    _stores.set(dbPath, store);
  }
  return store;
}

process.on("exit", () => {
  for (const store of _stores.values()) {
    try {
      store.close();
    } catch {
      // best-effort on exit
    }
  }
});

/** Test-only: closes and clears the cache so each test starts fresh. */
export function resetFtsStoreCacheForTest(): void {
  for (const store of _stores.values()) {
    try {
      store.close();
    } catch {
      // best-effort
    }
  }
  _stores.clear();
}
