import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HELPER_ENV,
  decodePayload,
  encodePayload,
  runHelper,
  runUserCommand,
  spawnHelpers,
} from "../../src/cmd-helper.ts";
import type { HelperPayload } from "../../src/cmd-helper.ts";
import { type CmdCacheEntry, claimLease, readCmdEntry } from "../../src/commands.ts";
import { MAX_CMD_STDOUT_BYTES, MAX_CMD_TIMEOUT_MS, MS_PER_SEC } from "../../src/constants.ts";
import { openDb } from "../../src/rate-limits.ts";
import { fixtureArgv as fixture, pollCachedOutput } from "../support/commands.ts";

const PAYLOAD: HelperPayload = {
  v: 1,
  dbPath: "/tmp/x.db",
  key: "cmdcache:a:b",
  token: "t1",
  argv: ["echo", "hi"],
  cwd: "/tmp",
  timeoutMs: 1000,
};

const nowSecs = (): number => Math.floor(Date.now() / MS_PER_SEC);

describe("payload codec", () => {
  test("round-trips", () => {
    expect(decodePayload(encodePayload(PAYLOAD))).toEqual(PAYLOAD);
  });

  test("rejects malformed input", () => {
    expect(decodePayload("")).toBeUndefined();
    expect(decodePayload("!!!not base64!!!")).toBeUndefined();
    expect(decodePayload(Buffer.from("not json").toString("base64url"))).toBeUndefined();
    expect(
      decodePayload(Buffer.from(JSON.stringify({ ...PAYLOAD, v: 2 })).toString("base64url")),
    ).toBeUndefined();
    expect(
      decodePayload(Buffer.from(JSON.stringify({ ...PAYLOAD, argv: [1] })).toString("base64url")),
    ).toBeUndefined();
    expect(
      decodePayload(Buffer.from(JSON.stringify({ ...PAYLOAD, argv: [] })).toString("base64url")),
    ).toBeUndefined();
    expect(
      decodePayload(
        Buffer.from(JSON.stringify({ ...PAYLOAD, argv: "echo hi" })).toString("base64url"),
      ),
    ).toBeUndefined();
  });

  test.each([
    ["empty argv element", { argv: ["echo", ""] }],
    ["zero timeout", { timeoutMs: 0 }],
    ["negative timeout", { timeoutMs: -1 }],
    ["fractional timeout", { timeoutMs: 1.5 }],
    ["NaN timeout", { timeoutMs: Number.NaN }],
    ["over-max timeout", { timeoutMs: MAX_CMD_TIMEOUT_MS + 1 }],
    ["foreign key prefix", { key: "render:abc" }],
    ["empty key", { key: "" }],
  ])("rejects %s", (_label, over) => {
    expect(
      decodePayload(Buffer.from(JSON.stringify({ ...PAYLOAD, ...over })).toString("base64url")),
    ).toBeUndefined();
  });

  test("accepts the boundary timeout values", () => {
    for (const timeoutMs of [1, MAX_CMD_TIMEOUT_MS]) {
      expect(decodePayload(encodePayload({ ...PAYLOAD, timeoutMs }))?.timeoutMs).toBe(timeoutMs);
    }
  });
});

describe("runUserCommand", () => {
  test("returns stdout for a successful command", async () => {
    expect(await runUserCommand(fixture("echo", "hello"), tmpdir(), 5000)).toBe("hello\n");
  });

  test("returns undefined on a nonzero exit", async () => {
    expect(await runUserCommand(fixture("fail"), tmpdir(), 5000)).toBeUndefined();
  });

  test("returns undefined on a missing binary", async () => {
    expect(await runUserCommand(["/nonexistent/binary-xyz"], tmpdir(), 5000)).toBeUndefined();
  });

  test("times out well before the command would finish", async () => {
    const started = Date.now();
    expect(await runUserCommand(fixture("sleep", "10000"), tmpdir(), 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an over-cap command returns the same bounded prefix every run", async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => runUserCommand(fixture("big", "1048576"), tmpdir(), 10_000)),
    );
    expect(runs[0]).toBe("x".repeat(MAX_CMD_STDOUT_BYTES));
    for (const out of runs) expect(out).toBe(runs[0]);
  }, 30_000);

  test("a multibyte over-cap stream never yields a replacement character", async () => {
    const out = await runUserCommand(fixture("bigmb", "1048576"), tmpdir(), 20_000);
    expect(out).toBeDefined();
    expect(out).not.toContain("\uFFFD");
    expect(Buffer.byteLength(out ?? "", "utf8")).toBeLessThanOrEqual(MAX_CMD_STDOUT_BYTES);
    expect(out).toBe("字".repeat(Math.floor(MAX_CMD_STDOUT_BYTES / 3)));
  }, 30_000);

  test("an unrelated nonzero exit is still a failure even with buffered output", async () => {
    expect(await runUserCommand(fixture("fail"), tmpdir(), 5000)).toBeUndefined();
    expect(await runUserCommand(fixture("sleep", "10000"), tmpdir(), 300)).toBeUndefined();
  });
});

describe("helper lifecycle", () => {
  let dir: string;
  let dbPath: string;
  const KEY = "cmdcache:k8s:abc";

  const cached = (): CmdCacheEntry | undefined => {
    const db = openDb(dbPath);
    try {
      return readCmdEntry(db, KEY);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hud-helper-"));
    dbPath = join(dir, "shared.db");
    const db = openDb(dbPath);
    claimLease(db, KEY, nowSecs(), 30, "t1");
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the sanitized command output", async () => {
    await runHelper(
      encodePayload({
        v: 1,
        dbPath,
        key: KEY,
        token: "t1",
        argv: fixture("ansi"),
        cwd: dir,
        timeoutMs: 5000,
      }),
    );
    expect(cached()?.output).toBe("red linex");
    expect(cached()?.leaseToken).toBe("");
  });

  test("a failed command keeps the prior output and clears the lease", async () => {
    const now = nowSecs();
    const db = openDb(dbPath);
    db.query("UPDATE kv SET v = json_set(v, '$.output', 'prior') WHERE k = ?").run(KEY);
    db.close();
    await runHelper(
      encodePayload({
        v: 1,
        dbPath,
        key: KEY,
        token: "t1",
        argv: fixture("fail"),
        cwd: dir,
        timeoutMs: 5000,
      }),
    );
    const entry = cached();
    expect(entry?.output).toBe("prior");
    expect(entry?.leaseToken).toBe("");
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(now);
  });

  test("a malformed payload is a silent no-op", async () => {
    await runHelper("garbage");
    expect(cached()?.leaseToken).toBe("t1");
  });

  test("a stale token writes nothing", async () => {
    await runHelper(
      encodePayload({
        v: 1,
        dbPath,
        key: KEY,
        token: "wrong",
        argv: fixture("echo", "x"),
        cwd: dir,
        timeoutMs: 5000,
      }),
    );
    expect(cached()?.output).toBe("");
    expect(cached()?.leaseToken).toBe("t1");
  });
});

describe("spawnHelpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-hud-spawn-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses to recurse when already inside a helper", () => {
    const task = {
      id: "k8s",
      key: "cmdcache:k8s:abc",
      token: "t1",
      cmd: { id: "k8s", argv: fixture("echo", "x"), timeoutMs: 1000, ttlSecs: 60 },
    };
    expect(spawnHelpers("/self.ts", join(dir, "x.db"), [task], dir, { [HELPER_ENV]: "1" })).toBe(0);
  });

  test("spawns a detached child that outlives its argv construction", async () => {
    const dbPath = join(dir, "shared.db");
    const marker = join(dir, "ran.txt");
    const key = "cmdcache:k8s:abc";
    const db = openDb(dbPath);
    claimLease(db, key, nowSecs(), 30, "t1");
    db.close();
    const selfPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const task = {
      id: "k8s",
      key,
      token: "t1",
      cmd: { id: "k8s", argv: fixture("count", marker, "spawned"), timeoutMs: 5000, ttlSecs: 60 },
    };
    expect(spawnHelpers(selfPath, dbPath, [task], dir, {})).toBe(1);
    expect(await pollCachedOutput(dbPath, key)).toBe("spawned");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
