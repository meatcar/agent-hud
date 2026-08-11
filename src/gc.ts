import type { Database } from "bun:sqlite";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { CMDCACHE_PREFIX, LEASE_FUTURE_HORIZON_SECS } from "./commands.ts";
import {
  CMD_CACHE_MAX_AGE_SECS,
  GC_CLOCK_SKEW_SECS,
  GC_INTERVAL_SECS,
  GC_MAX_AGE_SECS,
  MS_PER_SEC,
} from "./constants.ts";
import { getNumber, isObject } from "./json.ts";
import { openRenderDb } from "./rate-limits.ts";

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

const claimGc = (db: Database, now: number): boolean => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const last = lastGcAt(db);
    const plausible = last !== undefined && last <= now + GC_CLOCK_SKEW_SECS;
    if (last !== undefined && plausible && now - last < GC_INTERVAL_SECS) {
      db.exec("COMMIT");
      return false;
    }
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(GC_KEY, String(now));
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection may already have aborted the transaction.
    }
    throw error;
  }
};

const activityAt = (val: string): number | undefined => {
  try {
    return getNumber(JSON.parse(val) as unknown, "at");
  } catch {
    return undefined;
  }
};

const parseRow = (val: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(val);
    return isObject(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// A refresh that is still in flight must survive the sweep even if the row it
// Reclaimed carried an ancient updatedAt: the helper is about to write to it,
// And deleting the row would drop the lease and let a second helper spawn.
// Only a plausibly current lease counts; an expired or far-future stamp does not.
const hasLiveLease = (entry: Record<string, unknown>, now: number): boolean => {
  const leaseUntil = getNumber(entry, "leaseUntil");
  return (
    leaseUntil !== undefined && leaseUntil > now && leaseUntil <= now + LEASE_FUTURE_HORIZON_SECS
  );
};

// Command rows carry no session liveness, so they age out by updatedAt, except
// While a lease is live. Invalid rows are always prunable.
const pruneCmdRows = (db: Database, cutoff: number, now: number): void => {
  const rows = db
    .query<{ key: string; val: string }, [string]>(
      "SELECT k AS key, v AS val FROM kv WHERE k LIKE ? ORDER BY k",
    )
    .all(`${CMDCACHE_PREFIX}%`);
  const delSelected = db.query("DELETE FROM kv WHERE k = ? AND v = ?");
  for (const row of rows) {
    const entry = parseRow(row.val);
    const updatedAt = entry === undefined ? undefined : getNumber(entry, "updatedAt");
    if (
      entry === undefined ||
      ((updatedAt === undefined || updatedAt < cutoff) && !hasLiveLease(entry, now))
    ) {
      // A helper may claim a lease after this sweep's SELECT. Match the exact
      // Selected value so that newer output or lease state survives the prune.
      delSelected.run(row.key, row.val);
    }
  }
};

const pruneDbRows = (db: Database, cutoff: number, cmdCutoff: number, now: number): void => {
  // Written by earlier versions but never rendered; reclaim the space.
  db.exec("DROP TABLE IF EXISTS cache_miss");
  const delSelected = db.query("DELETE FROM kv WHERE k = ? AND v = ?");
  const exists = db.query("SELECT 1 FROM kv WHERE k = ?");
  const live = new Set<string>();
  const activities = db
    .query<{ key: string; val: string }, [string]>(
      "SELECT k AS key, v AS val FROM kv WHERE k LIKE ? ORDER BY k",
    )
    .all(`${ACTIVITY_PREFIX}%`);
  for (const row of activities) {
    const sessionId = row.key.slice(ACTIVITY_PREFIX.length);
    const at = activityAt(row.val);
    if (at !== undefined && at >= cutoff) {
      live.add(sessionId);
    } else if (delSelected.run(row.key, row.val).changes === 0 && exists.get(row.key) !== null) {
      // A changed value after the materialized scan makes this session live for
      // This sweep, so its render row cannot be deleted from stale evidence.
      live.add(sessionId);
    }
  }
  const renders = db
    .query<{ key: string; val: string }, [string]>(
      "SELECT k AS key, v AS val FROM kv WHERE k LIKE ? ORDER BY k",
    )
    .all(`${RENDER_PREFIX}%`);
  for (const row of renders) {
    if (!live.has(row.key.slice(RENDER_PREFIX.length))) {
      delSelected.run(row.key, row.val);
    }
  }
  pruneCmdRows(db, cmdCutoff, now);
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
    db = openRenderDb(dbPath);
    // Claim the sweep before pruning so concurrent sessions do not repeat it.
    if (!claimGc(db, now)) return false;
    pruneDbRows(db, now - GC_MAX_AGE_SECS, now - CMD_CACHE_MAX_AGE_SECS, now);
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
