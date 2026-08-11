import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Bucket,
  mergeBucket,
  mergeRateLimits,
  mergeWithSharedDb,
  openDb,
  openImmediateRenderDb,
  openRenderDb,
  readRateLimits,
  renderChanged,
  touchActivity,
  writeRateLimits,
} from "../../src/rate-limits.ts";
import { expectCleanProcesses, runSynchronized } from "../support/process.ts";

const NOW = 1_000_000;
const LIVE = NOW + 3600;
const EXPIRED = NOW - 1;
const WINNER_POSITIONS = [0, 8, 15];

const insertAt = <T>(items: readonly T[], position: number, winner: T): T[] => {
  const result = [...items];
  result.splice(position, 0, winner);
  return result;
};

describe("mergeBucket", () => {
  test("both undefined → undefined", () => {
    expect(mergeBucket(undefined, undefined, NOW)).toBeUndefined();
  });

  test("cached expired, incoming live → incoming", () => {
    const cached: Bucket = { pct: 80, resetsAt: EXPIRED };
    const incoming: Bucket = { pct: 30, resetsAt: LIVE };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(incoming);
  });

  test("incoming expired, cached live → cached", () => {
    const cached: Bucket = { pct: 50, resetsAt: LIVE };
    const incoming: Bucket = { pct: 20, resetsAt: EXPIRED };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(cached);
  });

  test("both expired → undefined", () => {
    expect(
      mergeBucket({ pct: 50, resetsAt: EXPIRED }, { pct: 20, resetsAt: EXPIRED }, NOW),
    ).toBeUndefined();
  });

  test("same resetsAt, incoming pct higher → incoming", () => {
    const cached: Bucket = { pct: 50, resetsAt: LIVE };
    const incoming: Bucket = { pct: 70, resetsAt: LIVE };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(incoming);
  });

  test("same resetsAt, cached pct higher → cached", () => {
    const cached: Bucket = { pct: 70, resetsAt: LIVE };
    const incoming: Bucket = { pct: 50, resetsAt: LIVE };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(cached);
  });

  test("incoming resetsAt later (new window), pct lower → incoming wins", () => {
    const cached: Bucket = { pct: 80, resetsAt: LIVE };
    const incoming: Bucket = { pct: 10, resetsAt: LIVE + 7200 };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(incoming);
  });

  test("incoming resetsAt earlier (stale stdin) → cached wins", () => {
    const cached: Bucket = { pct: 80, resetsAt: LIVE + 3600 };
    const incoming: Bucket = { pct: 90, resetsAt: LIVE };
    expect(mergeBucket(cached, incoming, NOW)).toEqual(cached);
  });

  test("only cached present → cached", () => {
    const cached: Bucket = { pct: 50, resetsAt: LIVE };
    expect(mergeBucket(cached, undefined, NOW)).toEqual(cached);
  });

  test("only incoming present → incoming", () => {
    const incoming: Bucket = { pct: 50, resetsAt: LIVE };
    expect(mergeBucket(undefined, incoming, NOW)).toEqual(incoming);
  });
});

describe("mergeRateLimits", () => {
  const b5 = (pct: number): Bucket => ({ pct, resetsAt: LIVE });
  const b7 = (pct: number): Bucket => ({ pct, resetsAt: LIVE + 100 });

  test("cached undefined, stdin empty → merged undefined, changed=false", () => {
    const { merged, changed } = mergeRateLimits(
      undefined,
      { fiveHour: undefined, sevenDay: undefined },
      NOW,
    );
    expect(merged).toEqual({ version: 1, fiveHour: undefined, sevenDay: undefined });
    expect(changed).toBe(false);
  });

  test("cached undefined, stdin has data → changed=true", () => {
    const { merged, changed } = mergeRateLimits(
      undefined,
      { fiveHour: b5(40), sevenDay: b7(20) },
      NOW,
    );
    expect(merged.fiveHour).toEqual(b5(40));
    expect(merged.sevenDay).toEqual(b7(20));
    expect(changed).toBe(true);
  });

  test("stdin missing one bucket → cached bucket preserved", () => {
    const cached = { version: 1 as const, fiveHour: b5(60), sevenDay: b7(30) };
    const { merged, changed } = mergeRateLimits(
      cached,
      { fiveHour: undefined, sevenDay: b7(40) },
      NOW,
    );
    expect(merged.fiveHour).toEqual(b5(60));
    expect(merged.sevenDay).toEqual(b7(40));
    expect(changed).toBe(true);
  });

  test("identical values → changed=false", () => {
    const cached = { version: 1 as const, fiveHour: b5(50), sevenDay: b7(25) };
    const { changed } = mergeRateLimits(cached, { fiveHour: b5(50), sevenDay: b7(25) }, NOW);
    expect(changed).toBe(false);
  });

  test("incoming pct higher same window → changed=true", () => {
    const cached = { version: 1 as const, fiveHour: b5(50), sevenDay: undefined };
    const { changed } = mergeRateLimits(cached, { fiveHour: b5(70), sevenDay: undefined }, NOW);
    expect(changed).toBe(true);
  });
});

describe("rate-limits DB helpers", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-hud-test-"));
    dbPath = join(tmpDir, "shared.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("read from empty db returns undefined", () => {
    expect(readRateLimits(db)).toBeUndefined();
  });

  test("write then read roundtrip", () => {
    const state = {
      version: 1 as const,
      fiveHour: { pct: 42, resetsAt: LIVE },
      sevenDay: undefined,
    };
    writeRateLimits(db, state);
    expect(readRateLimits(db)).toEqual(state);
  });

  test("write overwrites previous value", () => {
    writeRateLimits(db, { version: 1, fiveHour: { pct: 10, resetsAt: LIVE }, sevenDay: undefined });
    writeRateLimits(db, { version: 1, fiveHour: { pct: 99, resetsAt: LIVE }, sevenDay: undefined });
    expect(readRateLimits(db)?.fiveHour?.pct).toBe(99);
  });

  test("corrupt row returns undefined", () => {
    db.exec("INSERT OR REPLACE INTO kv VALUES ('rate_limits', 'not-json')");
    expect(readRateLimits(db)).toBeUndefined();
  });

  test("corrupt db file returns undefined on open", async () => {
    const badPath = join(tmpDir, "bad.db");
    await Bun.write(badPath, "this is not a sqlite file");
    let badDb: Database | undefined;
    expect(() => {
      badDb = openDb(badPath);
    }).toThrow();
    badDb?.close();
  });

  test("an extra callback failure rolls back the shared transaction", () => {
    const rollbackPath = join(tmpDir, "rollback.db");
    const result = mergeWithSharedDb(
      rollbackPath,
      {
        stdin: { fiveHour: { pct: 42, resetsAt: LIVE }, sevenDay: undefined },
        session: undefined,
        now: NOW,
      },
      (shared) => {
        shared.query("INSERT INTO kv (k, v) VALUES (?, ?)").run("extra", "written");
        throw new Error("boom");
      },
    );
    expect(result).toEqual({
      rateLimits: {
        version: 1,
        fiveHour: { pct: 42, resetsAt: LIVE },
        sevenDay: undefined,
      },
      lastActivity: NOW,
      extra: undefined,
    });
    const check = openDb(rollbackPath);
    expect(readRateLimits(check)).toBeUndefined();
    expect(check.query("SELECT v FROM kv WHERE k = 'extra'").get()).toBeNull();
    check.close();
  });

  test.each(WINNER_POSITIONS)(
    "long-budget synchronized same-window merges preserve a winner placed at index %d",
    async (winnerPosition) => {
      const path = join(tmpDir, `same-window-${winnerPosition}.db`);
      const pcts = insertAt(
        Array.from({ length: 15 }, (_, index) => index + 1),
        winnerPosition,
        16,
      );
      const initialized = openDb(path);
      initialized.close();
      const results = await runSynchronized(
        tmpDir,
        pcts.map((pct) => ["merge", path, String(NOW), String(pct), String(LIVE), "", ""]),
      );
      expectCleanProcesses(results);
      const finalDb = openDb(path);
      expect(readRateLimits(finalDb)?.fiveHour).toEqual({ pct: 16, resetsAt: LIVE });
      finalDb.close();
    },
    30_000,
  );

  test.each([
    [0, 1],
    [7, 8],
    [14, 15],
  ])(
    "long-budget complementary bucket winners survive at indices %d and %d",
    async (fiveWinnerPosition, sevenWinnerPosition) => {
      const path = join(tmpDir, `complementary-${fiveWinnerPosition}.db`);
      const inputs = Array.from({ length: 16 }, (_, index): string[] =>
        index < 8
          ? ["merge", path, String(NOW), String(index + 1), String(LIVE), "", ""]
          : ["merge", path, String(NOW), "", "", String(index - 7), String(LIVE + 100)],
      );
      inputs[fiveWinnerPosition] = ["merge", path, String(NOW), "15", String(LIVE), "", ""];
      inputs[sevenWinnerPosition] = ["merge", path, String(NOW), "", "", "16", String(LIVE + 100)];
      const initialized = openDb(path);
      initialized.close();
      const results = await runSynchronized(tmpDir, inputs);
      expectCleanProcesses(results);
      const finalDb = openDb(path);
      expect(readRateLimits(finalDb)).toEqual({
        version: 1,
        fiveHour: { pct: 15, resetsAt: LIVE },
        sevenDay: { pct: 16, resetsAt: LIVE + 100 },
      });
      finalDb.close();
    },
    30_000,
  );

  test.each(WINNER_POSITIONS)(
    "long-budget latest-reset winner survives when placed at index %d",
    async (winnerPosition) => {
      const path = join(tmpDir, `latest-window-${winnerPosition}.db`);
      const inputs = insertAt(
        Array.from({ length: 15 }, (_, index) => [
          "merge",
          path,
          String(NOW),
          String(100 - index),
          String(LIVE + index),
          "",
          "",
        ]),
        winnerPosition,
        ["merge", path, String(NOW), "85", String(LIVE + 15), "", ""],
      );
      const initialized = openDb(path);
      initialized.close();
      const results = await runSynchronized(tmpDir, inputs);
      expectCleanProcesses(results);
      const finalDb = openDb(path);
      expect(readRateLimits(finalDb)?.fiveHour).toEqual({ pct: 85, resetsAt: LIVE + 15 });
      finalDb.close();
    },
    30_000,
  );

  test("render connection lock budgets remain distinct", () => {
    const immediateDb = openImmediateRenderDb(dbPath);
    expect(immediateDb.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
      timeout: 0,
    });
    immediateDb.close();

    const transactionalDb = openRenderDb(dbPath);
    expect(transactionalDb.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
      timeout: 250,
    });
    transactionalDb.close();

    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
      timeout: 5000,
    });
  });

  test("immediate render opener does not initialize schema", () => {
    const rawPath = join(tmpDir, "immediate.db");
    const immediateDb = openImmediateRenderDb(rawPath);
    expect(
      immediateDb
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'")
        .get(),
    ).toBeNull();
    immediateDb.close();
  });

  test("render-path shared merge returns its fail-open fallback beneath a held writer", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const merged = mergeWithSharedDb(dbPath, {
        stdin: { fiveHour: { pct: 42, resetsAt: LIVE }, sevenDay: undefined },
        session: undefined,
        now: NOW,
      });
      expect(merged.rateLimits.fiveHour).toEqual({ pct: 42, resetsAt: LIVE });
      expect(merged.extra).toBeUndefined();
    } finally {
      db.exec("ROLLBACK");
    }
  });

  test("render fingerprint fails open promptly beneath a held writer", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(renderChanged(dbPath, "locked", "content")).toBe(true);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      db.exec("ROLLBACK");
    }
  });
});

describe("activity tracking DB", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-hud-test-"));
    db = openDb(join(tmpDir, "shared.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("first touch returns now", () => {
    expect(touchActivity(db, "sess1", "1:2:3", NOW)).toBe(NOW);
  });

  test("unchanged fingerprint keeps original timestamp", () => {
    touchActivity(db, "sess1", "1:2:3", NOW);
    expect(touchActivity(db, "sess1", "1:2:3", NOW + 500)).toBe(NOW);
  });

  test("changed fingerprint resets timestamp", () => {
    touchActivity(db, "sess1", "1:2:3", NOW);
    expect(touchActivity(db, "sess1", "9:9:9", NOW + 500)).toBe(NOW + 500);
  });

  test("sessions are isolated", () => {
    touchActivity(db, "sessA", "1:2:3", NOW);
    expect(touchActivity(db, "sessB", "1:2:3", NOW + 500)).toBe(NOW + 500);
    expect(touchActivity(db, "sessA", "1:2:3", NOW + 900)).toBe(NOW);
  });
});

describe("renderChanged", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-hud-test-"));
    dbPath = join(tmpDir, "shared.db");
    const initialized = openDb(dbPath);
    initialized.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing schema fails open without initializer side effects", () => {
    const rawPath = join(tmpDir, "uninitialized.db");
    expect(renderChanged(rawPath, "sess1", "content-a")).toBe(true);
    const rawDb = openImmediateRenderDb(rawPath);
    expect(
      rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get(),
    ).toBeNull();
    rawDb.close();
  });

  test("first render → changed", () => {
    expect(renderChanged(dbPath, "sess1", "content-a")).toBe(true);
  });

  test("same fingerprint → unchanged", () => {
    renderChanged(dbPath, "sess1", "content-a");
    expect(renderChanged(dbPath, "sess1", "content-a")).toBe(false);
  });

  test("different fingerprint → changed, then stable", () => {
    renderChanged(dbPath, "sess1", "content-a");
    expect(renderChanged(dbPath, "sess1", "content-b")).toBe(true);
    expect(renderChanged(dbPath, "sess1", "content-b")).toBe(false);
  });

  test("sessions are isolated", () => {
    renderChanged(dbPath, "sessA", "content-a");
    expect(renderChanged(dbPath, "sessB", "content-a")).toBe(true);
  });

  test("unusable db path → changed (fail open)", () => {
    expect(renderChanged(join(tmpDir, "no-such-dir", "x.db"), "sess1", "content-a")).toBe(true);
  });
});
