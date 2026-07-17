import type { Database } from "bun:sqlite";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { GC_INTERVAL_SECS, GC_MAX_AGE_SECS, MS_PER_SEC } from "./constants.ts";
import { getNumber } from "./json.ts";
import { openDb } from "./rate-limits.ts";

const GC_KEY = "gc:last";
const ACTIVITY_PREFIX = "activity:";
const RENDER_PREFIX = "render:";

const lastGcAt = (db: Database): number | undefined => {
  const row = db.query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?").get(GC_KEY);
  if (!row) {
    return undefined;
  }
  const at = Number(row.val);
  return Number.isFinite(at) ? at : undefined;
};

const activityAt = (val: string): number | undefined => {
  try {
    return getNumber(JSON.parse(val) as unknown, "at");
  } catch {
    return undefined;
  }
};

const pruneDbRows = (db: Database, cutoff: number): void => {
  // Written by earlier versions but never rendered; reclaim the space.
  db.exec("DROP TABLE IF EXISTS cache_miss");
  const del = db.query("DELETE FROM kv WHERE k = ?");
  const live = new Set<string>();
  const activities = db
    .query<{ key: string; val: string }, [string]>(
      "SELECT k AS key, v AS val FROM kv WHERE k LIKE ?",
    )
    .all(`${ACTIVITY_PREFIX}%`);
  for (const row of activities) {
    const at = activityAt(row.val);
    if (at === undefined || at < cutoff) {
      del.run(row.key);
    } else {
      live.add(row.key.slice(ACTIVITY_PREFIX.length));
    }
  }
  const renders = db
    .query<{ key: string }, [string]>("SELECT k AS key FROM kv WHERE k LIKE ?")
    .all(`${RENDER_PREFIX}%`);
  for (const row of renders) {
    if (!live.has(row.key.slice(RENDER_PREFIX.length))) {
      del.run(row.key);
    }
  }
};

// Session-start caches are keyed by session id and written once, so mtime is
// The session's start time; anything past the cutoff belongs to a dead session.
const pruneStateFiles = async (stateDir: string, cutoff: number): Promise<void> => {
  const names = await readdir(stateDir);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(stateDir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs / MS_PER_SEC < cutoff) {
            await unlink(path);
          }
        } catch {
          // Raced with another statusline instance; nothing to do.
        }
      }),
  );
};

// Opportunistic daily sweep of per-session leftovers (activity/render kv rows,
// Session-start cache files). Runs after output is flushed, so it never delays
// A render; any failure is swallowed — GC must not break the statusline.
export const maybeGc = async (dbPath: string, stateDir: string, now: number): Promise<boolean> => {
  let db: Database | undefined;
  try {
    db = openDb(dbPath);
    const last = lastGcAt(db);
    if (last !== undefined && last <= now && now - last < GC_INTERVAL_SECS) {
      return false;
    }
    // Claim the sweep up front so concurrent sessions don't repeat the work.
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(GC_KEY, String(now));
    pruneDbRows(db, now - GC_MAX_AGE_SECS);
  } catch {
    return false;
  } finally {
    db?.close();
  }
  try {
    await pruneStateFiles(stateDir, now - GC_MAX_AGE_SECS);
  } catch {
    // Best-effort: a missing state dir just means nothing to prune.
  }
  return true;
};
