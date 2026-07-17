import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Bucket,
  mergeBucket,
  mergeRateLimits,
  openDb,
  readRateLimits,
  renderChanged,
  touchActivity,
  writeRateLimits,
} from "./rate-limits.ts";

const NOW = 1_000_000;
const LIVE = NOW + 3600;
const EXPIRED = NOW - 1;

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
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-hud-test-"));
    db = openDb(join(tmpDir, "shared.db"));
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

  test("5 parallel writers, final row is valid JSON", async () => {
    const dbPath = join(tmpDir, "concurrent.db");
    const script = `
      import { openDb, writeRateLimits } from ${JSON.stringify(import.meta.resolve("./rate-limits.ts"))};
      const db = openDb(${JSON.stringify(dbPath)});
      writeRateLimits(db, { version: 1, fiveHour: { pct: ${Math.floor(Math.random() * 100)}, resetsAt: ${LIVE} }, sevenDay: undefined });
      db.close();
    `;
    await Promise.all(
      Array.from(
        { length: 5 },
        async () =>
          Bun.spawn(["bun", "--eval", script], { stdout: "ignore", stderr: "ignore" }).exited,
      ),
    );
    const finalDb = openDb(dbPath);
    const row = readRateLimits(finalDb);
    finalDb.close();
    expect(row).not.toBeUndefined();
    expect(row?.version).toBe(1);
    expect(typeof row?.fiveHour?.pct).toBe("number");
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
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
