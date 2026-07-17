import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GC_INTERVAL_SECS, GC_MAX_AGE_SECS, SEC_PER_DAY } from "./constants.ts";
import { maybeGc } from "./gc.ts";
import { openDb } from "./rate-limits.ts";

const NOW = 1_800_000_000;
const OLD = NOW - GC_MAX_AGE_SECS - SEC_PER_DAY;
const FRESH = NOW - SEC_PER_DAY;

describe("maybeGc", () => {
  let stateDir: string;
  let dbPath: string;

  const seedKv = (key: string, val: string): void => {
    const db = openDb(dbPath);
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(key, val);
    db.close();
  };

  const kvKeys = (): string[] => {
    const db = new Database(dbPath, { readonly: true });
    const keys = db
      .query<{ key: string }, []>("SELECT k AS key FROM kv ORDER BY k")
      .all()
      .map((row) => row.key);
    db.close();
    return keys;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agent-hud-gc-"));
    dbPath = join(stateDir, "shared.db");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("prunes stale activity rows, keeps fresh ones", async () => {
    seedKv("activity:old", JSON.stringify({ fp: "x", at: OLD }));
    seedKv("activity:new", JSON.stringify({ fp: "y", at: FRESH }));
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
    expect(kvKeys()).toEqual(["activity:new", "gc:last"]);
  });

  test("prunes render rows without live activity", async () => {
    seedKv("activity:live", JSON.stringify({ fp: "y", at: FRESH }));
    seedKv("render:live", "fp");
    seedKv("render:orphan", "fp");
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["activity:live", "gc:last", "render:live"]);
  });

  test("corrupt activity rows are pruned", async () => {
    seedKv("activity:corrupt", "not json");
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["gc:last"]);
  });

  test("drops the vestigial cache_miss table", async () => {
    const db = openDb(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS cache_miss (session_id TEXT, miss_pct REAL)");
    db.close();
    await maybeGc(dbPath, stateDir, NOW);
    const check = new Database(dbPath, { readonly: true });
    const table = check
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cache_miss'")
      .get();
    check.close();
    expect(table).toBeNull();
  });

  test("deletes old session json files, keeps fresh ones and the db", async () => {
    const oldFile = join(stateDir, "old-session.json");
    const freshFile = join(stateDir, "fresh-session.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(freshFile, "{}");
    utimesSync(oldFile, OLD, OLD);
    utimesSync(freshFile, FRESH, FRESH);
    await maybeGc(dbPath, stateDir, NOW);
    expect(await Bun.file(oldFile).exists()).toBe(false);
    expect(await Bun.file(freshFile).exists()).toBe(true);
    expect(await Bun.file(dbPath).exists()).toBe(true);
  });

  test("no-op within the interval", async () => {
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
    seedKv("activity:old", JSON.stringify({ fp: "x", at: OLD }));
    expect(await maybeGc(dbPath, stateDir, NOW + GC_INTERVAL_SECS - 1)).toBe(false);
    expect(kvKeys()).toContain("activity:old");
  });

  test("runs again once the interval elapses", async () => {
    await maybeGc(dbPath, stateDir, NOW);
    seedKv("activity:old", JSON.stringify({ fp: "x", at: OLD }));
    expect(await maybeGc(dbPath, stateDir, NOW + GC_INTERVAL_SECS + 1)).toBe(true);
    expect(kvKeys()).not.toContain("activity:old");
  });

  test("future gc:last stamp is treated as stale", async () => {
    seedKv("gc:last", String(NOW + GC_INTERVAL_SECS * 10));
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
  });

  test("unusable db path → false, no throw", async () => {
    expect(await maybeGc(join(stateDir, "missing", "x.db"), stateDir, NOW)).toBe(false);
  });
});
