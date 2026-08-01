import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CMD_CACHE_MAX_AGE_SECS,
  GC_CLOCK_SKEW_SECS,
  GC_INTERVAL_SECS,
  GC_MAX_AGE_SECS,
  SEC_PER_DAY,
} from "../../src/constants.ts";
import { LEASE_FUTURE_HORIZON_SECS, claimLease, readCmdEntry } from "../../src/commands.ts";
import { maybeGc } from "../../src/gc.ts";
import { openDb } from "../../src/rate-limits.ts";
import { expectCleanProcesses, runSynchronized } from "../support/process.ts";

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

  const kvValue = (key: string): string | undefined => {
    const db = new Database(dbPath, { readonly: true });
    const value = db
      .query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k = ?")
      .get(key)?.val;
    db.close();
    return value;
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

  test("a refreshed activity after the scan survives and keeps its render row", async () => {
    const stale = JSON.stringify({ fp: "old", at: OLD });
    const refreshed = JSON.stringify({ fp: "new", at: FRESH });
    const db = openDb(dbPath);
    const insert = db.query("INSERT INTO kv (k, v) VALUES (?, ?)");
    insert.run("activity:00-sentinel", stale);
    insert.run("activity:zz-target", stale);
    insert.run("render:zz-target", "rendered");
    db.exec("CREATE TABLE gc_test_updates (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    db.query("INSERT INTO gc_test_updates (k, v) VALUES (?, ?)").run(
      "activity:zz-target",
      refreshed,
    );
    db.exec(`CREATE TRIGGER refresh_activity_after_sentinel
      AFTER DELETE ON kv WHEN OLD.k = 'activity:00-sentinel'
      BEGIN
        UPDATE kv SET v = (SELECT v FROM gc_test_updates WHERE k = 'activity:zz-target')
        WHERE k = 'activity:zz-target';
      END`);
    db.close();

    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
    expect(kvValue("activity:zz-target")).toBe(refreshed);
    expect(kvValue("render:zz-target")).toBe("rendered");
    expect(kvKeys()).not.toContain("activity:00-sentinel");
  });

  test("a refreshed render after the scan survives compare-and-swap pruning", async () => {
    const db = openDb(dbPath);
    const insert = db.query("INSERT INTO kv (k, v) VALUES (?, ?)");
    insert.run("render:00-sentinel", "old-sentinel");
    insert.run("render:zz-target", "old-target");
    db.exec("CREATE TABLE gc_test_updates (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    db.query("INSERT INTO gc_test_updates (k, v) VALUES (?, ?)").run(
      "render:zz-target",
      "new-target",
    );
    db.exec(`CREATE TRIGGER refresh_render_after_sentinel
      AFTER DELETE ON kv WHEN OLD.k = 'render:00-sentinel'
      BEGIN
        UPDATE kv SET v = (SELECT v FROM gc_test_updates WHERE k = 'render:zz-target')
        WHERE k = 'render:zz-target';
      END`);
    db.close();

    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
    expect(kvValue("render:zz-target")).toBe("new-target");
    expect(kvKeys()).not.toContain("render:00-sentinel");
  });

  test("prunes old command cache rows, keeps fresh ones", async () => {
    const old = NOW - CMD_CACHE_MAX_AGE_SECS - SEC_PER_DAY;
    seedKv(
      "cmdcache:old:h",
      JSON.stringify({ output: "x", updatedAt: old, leaseUntil: 0, leaseToken: "" }),
    );
    seedKv(
      "cmdcache:new:h",
      JSON.stringify({ output: "y", updatedAt: NOW - 60, leaseUntil: 0, leaseToken: "" }),
    );
    seedKv("cmdcache:corrupt:h", "not json");
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["cmdcache:new:h", "gc:last"]);
  });

  test("never prunes a live lease on a row whose prior updatedAt is ancient", async () => {
    const old = NOW - CMD_CACHE_MAX_AGE_SECS - SEC_PER_DAY;
    seedKv(
      "cmdcache:warm:h",
      JSON.stringify({ output: "x", updatedAt: old, leaseUntil: NOW + 10, leaseToken: "t1" }),
    );
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toContain("cmdcache:warm:h");
  });

  test("prunes an old row whose lease is expired or implausibly far ahead", async () => {
    const old = NOW - CMD_CACHE_MAX_AGE_SECS - SEC_PER_DAY;
    seedKv(
      "cmdcache:expired:h",
      JSON.stringify({ output: "x", updatedAt: old, leaseUntil: old + 10, leaseToken: "t1" }),
    );
    seedKv(
      "cmdcache:future:h",
      JSON.stringify({ output: "x", updatedAt: old, leaseUntil: NOW + 1_000_000, leaseToken: "t" }),
    );
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["gc:last"]);
  });

  test("keeps an old row whose lease sits exactly at the plausibility horizon", async () => {
    const old = NOW - CMD_CACHE_MAX_AGE_SECS - SEC_PER_DAY;
    seedKv(
      "cmdcache:edge:h",
      JSON.stringify({
        output: "x",
        updatedAt: old,
        leaseUntil: NOW + LEASE_FUTURE_HORIZON_SECS,
        leaseToken: "t1",
      }),
    );
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toContain("cmdcache:edge:h");
  });

  test("prunes an old row whose lease is one second past the horizon", async () => {
    const old = NOW - CMD_CACHE_MAX_AGE_SECS - SEC_PER_DAY;
    seedKv(
      "cmdcache:past:h",
      JSON.stringify({
        output: "x",
        updatedAt: old,
        leaseUntil: NOW + LEASE_FUTURE_HORIZON_SECS + 1,
        leaseToken: "t1",
      }),
    );
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["gc:last"]);
  });

  test("prunes array and scalar cmdcache rows", async () => {
    seedKv("cmdcache:arr:h", "[1,2,3]");
    seedKv("cmdcache:num:h", "5");
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toEqual(["gc:last"]);
  });

  test("never prunes a lease claimed this instant", async () => {
    const db = openDb(dbPath);
    claimLease(db, "cmdcache:live:h", NOW, 10, "t1");
    db.close();
    await maybeGc(dbPath, stateDir, NOW);
    expect(kvKeys()).toContain("cmdcache:live:h");
  });

  test("a lease claimed after the command scan survives compare-and-swap pruning", async () => {
    const sentinel = "cmdcache:race:00-sentinel";
    const target = "cmdcache:race:zz-target";
    const stale = JSON.stringify({ output: "old", updatedAt: OLD, leaseUntil: 0, leaseToken: "" });
    const leased = JSON.stringify({
      output: "old",
      updatedAt: NOW,
      leaseUntil: NOW + 10,
      leaseToken: "race-token",
    });
    const db = openDb(dbPath);
    const insert = db.query("INSERT INTO kv (k, v) VALUES (?, ?)");
    insert.run(sentinel, stale);
    insert.run(target, stale);
    db.exec("CREATE TABLE gc_test_updates (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    db.query("INSERT INTO gc_test_updates (k, v) VALUES (?, ?)").run(target, leased);
    db.exec(`CREATE TRIGGER lease_command_after_sentinel
      AFTER DELETE ON kv WHEN OLD.k = 'cmdcache:race:00-sentinel'
      BEGIN
        UPDATE kv SET v = (SELECT v FROM gc_test_updates WHERE k = 'cmdcache:race:zz-target')
        WHERE k = 'cmdcache:race:zz-target';
      END`);
    db.close();

    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
    const check = openDb(dbPath);
    expect(readCmdEntry(check, target)?.leaseToken).toBe("race-token");
    check.close();
    expect(kvKeys()).not.toContain(sentinel);
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

  test.each([0, 1, 2])(
    "exactly one synchronized caller claims an eligible sweep (round %d)",
    async (round) => {
      const initialized = openDb(dbPath);
      initialized.close();
      const results = await runSynchronized(
        stateDir,
        Array.from({ length: 16 }, (_, index) => [
          "gc",
          dbPath,
          stateDir,
          String(round === 0 || index % 2 === 0 ? NOW : NOW + 1),
        ]),
        30_000,
      );
      expectCleanProcesses(results);
      expect(results.filter((result) => result.out.trim() === "true")).toHaveLength(1);
      expect(results.filter((result) => result.out.trim() === "false")).toHaveLength(15);
    },
    60_000,
  );

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

  test("a modest future gc:last stamp remains authoritative", async () => {
    seedKv("gc:last", String(NOW + GC_CLOCK_SKEW_SECS));
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(false);
  });

  test("a gc:last stamp beyond the clock-skew grace is reclaimed", async () => {
    seedKv("gc:last", String(NOW + GC_CLOCK_SKEW_SECS + 1));
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
  });

  test("an implausibly far-future gc:last stamp is treated as stale", async () => {
    seedKv("gc:last", String(NOW + GC_INTERVAL_SECS * 10));
    expect(await maybeGc(dbPath, stateDir, NOW)).toBe(true);
  });

  test("unusable db path → false, no throw", async () => {
    expect(await maybeGc(join(stateDir, "missing", "x.db"), stateDir, NOW)).toBe(false);
  });
});
