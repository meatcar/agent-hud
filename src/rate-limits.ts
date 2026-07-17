import { Database } from "bun:sqlite";

import { SEVEN_DAY_SECS } from "./constants.ts";
import { toEpoch } from "./helpers.ts";
import { getNumber, getString, isObject } from "./json.ts";

export interface Bucket {
  pct: number;
  resetsAt: number;
}

export interface RateLimitsV1 {
  version: 1;
  fiveHour: Bucket | undefined;
  sevenDay: Bucket | undefined;
}

export interface StdinBuckets {
  fiveHour: Bucket | undefined;
  sevenDay: Bucket | undefined;
}

export const mergeBucket = (
  cached: Bucket | undefined,
  incoming: Bucket | undefined,
  now: number,
): Bucket | undefined => {
  const isLive = (bucket: Bucket) =>
    bucket.resetsAt > now && bucket.resetsAt - now <= SEVEN_DAY_SECS;
  const liveC = cached && isLive(cached) ? cached : undefined;
  const liveI = incoming && isLive(incoming) ? incoming : undefined;
  if (!liveC || !liveI) {
    return liveC ?? liveI;
  }
  if (liveI.resetsAt > liveC.resetsAt) {
    return liveI;
  }
  if (liveI.resetsAt === liveC.resetsAt) {
    return liveI.pct > liveC.pct ? liveI : liveC;
  }
  return liveC;
};

const bucketEq = (left: Bucket | undefined, right: Bucket | undefined): boolean => {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.pct === right.pct && left.resetsAt === right.resetsAt;
};

export const mergeRateLimits = (
  cached: RateLimitsV1 | undefined,
  stdin: StdinBuckets,
  now: number,
): { merged: RateLimitsV1; changed: boolean } => {
  const fiveHour = mergeBucket(cached?.fiveHour, stdin.fiveHour, now);
  const sevenDay = mergeBucket(cached?.sevenDay, stdin.sevenDay, now);
  const merged: RateLimitsV1 = { version: 1, fiveHour, sevenDay };
  const changed = !bucketEq(fiveHour, cached?.fiveHour) || !bucketEq(sevenDay, cached?.sevenDay);
  return { merged, changed };
};

export const makeBucket = (
  pct: number | undefined,
  resetAt: string | number | undefined,
): Bucket | undefined => {
  if (pct === undefined) {
    return undefined;
  }
  const resetsAt = toEpoch(resetAt);
  if (resetsAt === undefined) {
    return undefined;
  }
  return { pct, resetsAt };
};

export const openDb = (path: string): Database => {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  return db;
};

const RATE_LIMITS_KEY = "rate_limits";

export const readRateLimits = (db: Database): RateLimitsV1 | undefined => {
  try {
    const row = db
      .query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?")
      .get(RATE_LIMITS_KEY);
    if (!row) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(row.val);
    if (!isObject(parsed) || getNumber(parsed, "version") !== 1) {
      return undefined;
    }
    const parseB = (key: string): Bucket | undefined => {
      const pct = getNumber(parsed, key, "pct");
      const resetsAt = getNumber(parsed, key, "resetsAt");
      if (pct === undefined || resetsAt === undefined) {
        return undefined;
      }
      return { pct, resetsAt };
    };
    return { version: 1, fiveHour: parseB("fiveHour"), sevenDay: parseB("sevenDay") };
  } catch {
    return undefined;
  }
};

export const writeRateLimits = (db: Database, state: RateLimitsV1): void => {
  db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(
    RATE_LIMITS_KEY,
    JSON.stringify(state),
  );
};

// Timer for the prompt-cache TTL: the fingerprint is the current usage token
// Counts, which only change when a new API response lands. Renders without a
// Fingerprint change (vim toggles, refreshInterval ticks) keep the old timestamp,
// So lastActivity tracks the last real request, not the last render.
export const touchActivity = (
  db: Database,
  sessionId: string,
  fingerprint: string,
  now: number,
): number => {
  const key = `activity:${sessionId}`;
  const row = db.query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?").get(key);
  if (row) {
    try {
      const parsed: unknown = JSON.parse(row.val);
      const at = getNumber(parsed, "at");
      if (at !== undefined && getString(parsed, "fp") === fingerprint) {
        return at;
      }
    } catch {
      // Fall through to rewrite the corrupt row
    }
  }
  db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(
    key,
    JSON.stringify({ fp: fingerprint, at: now }),
  );
  return now;
};

// Fingerprint of the last rendered content, excluding time-derived labels
// (clock, TTL countdown, ETAs). An unchanged fingerprint marks an idle
// Re-render, which may sleep to the minute boundary before printing.
export const renderChanged = (dbPath: string, sessionId: string, fingerprint: string): boolean => {
  let db: Database | undefined;
  try {
    db = openDb(dbPath);
    const key = `render:${sessionId}`;
    const row = db.query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?").get(key);
    if (row?.val === fingerprint) {
      return false;
    }
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(key, fingerprint);
    return true;
  } catch {
    // Fail open: an unreadable DB must never delay a render.
    return true;
  } finally {
    db?.close();
  }
};

export interface SessionInfo {
  sessionId: string;
  fingerprint: string;
}

export interface SharedDbOpts {
  stdin: StdinBuckets;
  session: SessionInfo | undefined;
  now: number;
}

export interface SharedDbResult {
  rateLimits: RateLimitsV1;
  lastActivity: number | undefined;
}

const doMerge = (db: Database, opts: SharedDbOpts): SharedDbResult => {
  const cached = readRateLimits(db);
  const { merged, changed } = mergeRateLimits(cached, opts.stdin, opts.now);
  if (changed) {
    writeRateLimits(db, merged);
  }
  const lastActivity =
    opts.session !== undefined
      ? touchActivity(db, opts.session.sessionId, opts.session.fingerprint, opts.now)
      : undefined;
  return { rateLimits: merged, lastActivity };
};

export const mergeWithSharedDb = (dbPath: string, opts: SharedDbOpts): SharedDbResult => {
  let db: Database | undefined;
  try {
    db = openDb(dbPath);
    return doMerge(db, opts);
  } catch {
    // No DB → no timer history; report fresh activity rather than a false wilt.
    return {
      rateLimits: { version: 1, ...opts.stdin },
      lastActivity: opts.now,
    };
  } finally {
    db?.close();
  }
};
