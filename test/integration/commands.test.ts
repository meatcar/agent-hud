import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CustomCommand,
  LEASE_FUTURE_HORIZON_SECS,
  MAX_LEASE_SECS,
  cacheKey,
  claimLease,
  customPass,
  readCmdEntry,
  resolveCommands,
  writeCmdResult,
} from "../../src/commands.ts";
import { openDb } from "../../src/rate-limits.ts";
import { expectCleanProcesses, runSynchronized } from "../support/process.ts";

const cmd = (over: Partial<CustomCommand> = {}): CustomCommand => ({
  id: "k8s",
  argv: ["echo", "hi"],
  timeoutMs: 5000,
  ttlSecs: 60,
  ...over,
});

describe("cacheKey", () => {
  test("is stable for identical inputs", () => {
    expect(cacheKey("k8s", cmd(), "/a")).toBe(cacheKey("k8s", cmd(), "/a"));
  });

  test("differs across cwd, argv, and timing", () => {
    const base = cacheKey("k8s", cmd(), "/a");
    expect(cacheKey("k8s", cmd(), "/b")).not.toBe(base);
    expect(cacheKey("k8s", cmd({ argv: ["echo", "yo"] }), "/a")).not.toBe(base);
    expect(cacheKey("k8s", cmd({ ttlSecs: 30 }), "/a")).not.toBe(base);
    expect(cacheKey("k8s", cmd({ timeoutMs: 100 }), "/a")).not.toBe(base);
  });

  test("is prefixed for GC sweeps", () => {
    expect(cacheKey("k8s", cmd(), "/a")).toStartWith("cmdcache:k8s:");
  });
});

describe("resolveCommands", () => {
  test("resolves known ids in order and skips unknown ones", () => {
    const commands = new Map([
      ["a", cmd({ id: "a" })],
      ["b", cmd({ id: "b" })],
    ]);
    const resolved = resolveCommands(commands, ["b", "ghost", "a"], "/x");
    expect(resolved.map((entry) => entry.cmd.id)).toEqual(["b", "a"]);
    expect(resolved[0]?.key).toBe(cacheKey("b", cmd({ id: "b" }), "/x"));
  });
});

const NOW = 1_800_000_000;

describe("lease and result writes", () => {
  let dir: string;
  let db: Database;
  const KEY = "cmdcache:k8s:abc";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hud-cmd-"));
    db = openDb(join(dir, "shared.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("cold claim wins and creates the row", () => {
    expect(claimLease(db, KEY, NOW, 10, "t1")).toBe(true);
    const entry = readCmdEntry(db, KEY);
    expect(entry?.leaseToken).toBe("t1");
    expect(entry?.leaseUntil).toBe(NOW + 10);
    expect(entry?.output).toBe("");
  });

  test("a second claim while the lease is live loses", () => {
    expect(claimLease(db, KEY, NOW, 10, "t1")).toBe(true);
    expect(claimLease(db, KEY, NOW, 10, "t2")).toBe(false);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t1");
  });

  test("an expired lease is reclaimable", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    expect(claimLease(db, KEY, NOW + 11, 10, "t2")).toBe(true);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t2");
  });

  test("an implausibly future lease stamp is treated as stale", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    db.query("UPDATE kv SET v = json_set(v, '$.leaseUntil', ?) WHERE k = ?").run(
      NOW + 1_000_000,
      KEY,
    );
    expect(claimLease(db, KEY, NOW, 10, "t2")).toBe(true);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t2");
  });

  test("a corrupt row is repaired and claimed", () => {
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(KEY, "not json");
    expect(claimLease(db, KEY, NOW, 10, "t1")).toBe(true);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t1");
  });

  test("a live lease is not stolen by a caller whose clock lags", () => {
    expect(claimLease(db, KEY, NOW, 10, "t1")).toBe(true);
    expect(claimLease(db, KEY, NOW - 1, 10, "t2")).toBe(false);
    expect(claimLease(db, KEY, NOW - 5, 10, "t3")).toBe(false);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t1");
  });

  for (const lag of [1, 5, 60]) {
    test(`a max-length lease survives a caller ${lag} seconds behind`, () => {
      expect(claimLease(db, KEY, NOW, MAX_LEASE_SECS, "t1")).toBe(true);
      expect(claimLease(db, KEY, NOW - lag, 10, "t2")).toBe(false);
      expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t1");
    });
  }

  test("a lease exactly at the plausibility horizon is still respected", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    db.query("UPDATE kv SET v = json_set(v, '$.leaseUntil', ?) WHERE k = ?").run(
      NOW + LEASE_FUTURE_HORIZON_SECS,
      KEY,
    );
    expect(claimLease(db, KEY, NOW, 10, "t2")).toBe(false);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t1");
  });

  test("a lease one second past the horizon is reclaimable", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    db.query("UPDATE kv SET v = json_set(v, '$.leaseUntil', ?) WHERE k = ?").run(
      NOW + LEASE_FUTURE_HORIZON_SECS + 1,
      KEY,
    );
    expect(claimLease(db, KEY, NOW, 10, "t2")).toBe(true);
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t2");
  });

  test("reclaiming an expired lease preserves the cached output", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    writeCmdResult(db, KEY, "t1", "prior", NOW + 1);
    expect(claimLease(db, KEY, NOW + 500, 10, "t2")).toBe(true);
    const entry = readCmdEntry(db, KEY);
    expect(entry?.output).toBe("prior");
    expect(entry?.leaseToken).toBe("t2");
    expect(entry?.leaseUntil).toBe(NOW + 510);
    expect(entry?.updatedAt).toBe(NOW + 500);
  });

  test.each([
    ["array", "[1,2,3]"],
    ["scalar number", "5"],
    ["scalar string", '"hello"'],
    ["scalar null", "null"],
    ["malformed", "{oops"],
  ])("a %s row is atomically repaired into a fresh object", (_label, raw) => {
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(KEY, raw);
    expect(claimLease(db, KEY, NOW, 10, "t1")).toBe(true);
    expect(readCmdEntry(db, KEY)).toEqual({
      output: "",
      updatedAt: NOW,
      leaseUntil: NOW + 10,
      leaseToken: "t1",
    });
  });

  test("exactly one of many same-instant claims wins", () => {
    const wins = Array.from({ length: 20 }, (_, i) => claimLease(db, KEY, NOW, 10, `t${i}`)).filter(
      Boolean,
    );
    expect(wins).toHaveLength(1);
  });

  test("exactly one claim wins across staggered clocks", () => {
    const nows = [NOW, NOW - 1, NOW + 1, NOW - 2, NOW, NOW + 2];
    const wins = nows.map((at, i) => claimLease(db, KEY, at, 10, `t${i}`)).filter(Boolean);
    expect(wins).toHaveLength(1);
  });

  test("exactly one independent process claims and later reclaims a lease", async () => {
    const dbPath = join(dir, "shared.db");
    const claim = async (at: number, prefix: string) => {
      const results = await runSynchronized(
        dir,
        Array.from({ length: 16 }, (_, index) => [
          "lease",
          dbPath,
          KEY,
          String(at),
          "10",
          `${prefix}${index}`,
        ]),
      );
      expectCleanProcesses(results);
      expect(results.filter((result) => result.out.trim() === "true")).toHaveLength(1);
      expect(results.filter((result) => result.out.trim() === "false")).toHaveLength(15);
    };

    await claim(NOW, "first-");
    await claim(NOW + 11, "second-");
    expect(readCmdEntry(db, KEY)?.leaseToken).toStartWith("second-");
  }, 30_000);

  test("readCmdEntry rejects array and scalar rows", () => {
    for (const raw of ["[1,2,3]", "5", '"hello"', "null", "true", "not json"]) {
      db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(KEY, raw);
      expect(readCmdEntry(db, KEY)).toBeUndefined();
    }
  });

  test("writeCmdResult never throws and updates nothing for non-object rows", () => {
    for (const raw of ["not json", "[1,2,3]", "5", '"hello"']) {
      db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(KEY, raw);
      expect(writeCmdResult(db, KEY, "t1", "out", NOW)).toBe(false);
      expect(
        db.query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?").get(KEY)?.val,
      ).toBe(raw);
    }
  });

  test("a cold claim stamps updatedAt so GC cannot prune a live lease", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    expect(readCmdEntry(db, KEY)?.updatedAt).toBeGreaterThanOrEqual(NOW);
  });

  test("matching token writes the result and clears the lease", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    expect(writeCmdResult(db, KEY, "t1", "prod", NOW + 1)).toBe(true);
    expect(readCmdEntry(db, KEY)).toEqual({
      output: "prod",
      updatedAt: NOW + 1,
      leaseUntil: 0,
      leaseToken: "",
    });
  });

  test("a late helper with a stale token writes nothing", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    claimLease(db, KEY, NOW + 11, 10, "t2");
    expect(writeCmdResult(db, KEY, "t1", "stale", NOW + 12)).toBe(false);
    expect(readCmdEntry(db, KEY)?.output).toBe("");
    expect(readCmdEntry(db, KEY)?.leaseToken).toBe("t2");
  });

  test("a failed run stamps updatedAt, keeps output, clears the lease", () => {
    claimLease(db, KEY, NOW, 10, "t1");
    writeCmdResult(db, KEY, "t1", "good", NOW + 1);
    claimLease(db, KEY, NOW + 100, 10, "t2");
    expect(writeCmdResult(db, KEY, "t2", undefined, NOW + 101)).toBe(true);
    expect(readCmdEntry(db, KEY)).toEqual({
      output: "good",
      updatedAt: NOW + 101,
      leaseUntil: 0,
      leaseToken: "",
    });
  });
});

describe("customPass", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hud-pass-"));
    db = openDb(join(dir, "shared.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A closed handle throws on any statement, so returning cleanly proves the
  // Empty-layout path never touches the DB (no query, no lease, no prepare).
  test("does no DB work when nothing is referenced", () => {
    const closed = openDb(join(dir, "closed.db"));
    closed.close();
    expect(customPass(closed, [], NOW, 4)).toEqual({ outputs: new Map(), tasks: [] });
  });

  test("a broken DB degrades to empty output without throwing", () => {
    const closed = openDb(join(dir, "closed2.db"));
    closed.close();
    const resolved = resolveCommands(new Map([["k8s", cmd()]]), ["k8s"], "/x");
    expect(customPass(closed, resolved, NOW, 4)).toEqual({
      outputs: new Map([["k8s", ""]]),
      tasks: [],
    });
  });

  test("a cold entry renders empty and claims one refresh task", () => {
    const resolved = resolveCommands(new Map([["k8s", cmd()]]), ["k8s"], "/x");
    const pass = customPass(db, resolved, NOW, 4);
    expect(pass.outputs.get("k8s")).toBe("");
    expect(pass.tasks).toHaveLength(1);
    expect(pass.tasks[0]?.cmd.id).toBe("k8s");
  });

  test("a fresh entry renders its value with no task", () => {
    const resolved = resolveCommands(new Map([["k8s", cmd()]]), ["k8s"], "/x");
    const key = resolved[0]?.key ?? "";
    claimLease(db, key, NOW, 10, "t1");
    writeCmdResult(db, key, "t1", "prod-cluster", NOW);
    const pass = customPass(db, resolved, NOW + 1, 4);
    expect(pass.outputs.get("k8s")).toBe("prod-cluster");
    expect(pass.tasks).toHaveLength(0);
  });

  test("a stale entry still renders its old value and claims a task", () => {
    const resolved = resolveCommands(new Map([["k8s", cmd({ ttlSecs: 10 })]]), ["k8s"], "/x");
    const key = resolved[0]?.key ?? "";
    claimLease(db, key, NOW, 10, "t1");
    writeCmdResult(db, key, "t1", "old", NOW);
    const pass = customPass(db, resolved, NOW + 11, 4);
    expect(pass.outputs.get("k8s")).toBe("old");
    expect(pass.tasks).toHaveLength(1);
  });

  test("output is sanitized on read", () => {
    const resolved = resolveCommands(new Map([["k8s", cmd()]]), ["k8s"], "/x");
    const key = resolved[0]?.key ?? "";
    claimLease(db, key, NOW, 10, "t1");
    writeCmdResult(db, key, "t1", "\u001B[31mred\nline", NOW);
    expect(customPass(db, resolved, NOW, 4).outputs.get("k8s")).toBe("red line");
  });

  test("a held lease blocks a second pass in the same second", () => {
    const resolved = resolveCommands(new Map([["k8s", cmd()]]), ["k8s"], "/x");
    expect(customPass(db, resolved, NOW, 4).tasks).toHaveLength(1);
    expect(customPass(db, resolved, NOW, 4).tasks).toHaveLength(0);
  });

  test("maxSpawns caps the number of tasks", () => {
    const commands = new Map(
      ["a", "b", "c"].map((id) => [id, cmd({ id })] as [string, CustomCommand]),
    );
    const resolved = resolveCommands(commands, ["a", "b", "c"], "/x");
    const pass = customPass(db, resolved, NOW, 2);
    expect(pass.tasks).toHaveLength(2);
    expect(pass.outputs.size).toBe(3);
  });
});
