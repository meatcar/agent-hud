import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSessionStart } from "./session.ts";

const ISO = "2026-01-02T03:04:05.000Z";
const EPOCH = Math.floor(Date.parse(ISO) / 1000);

describe("loadSessionStart", () => {
  let tmpDir: string;
  let stateDir: string;
  let transcript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-hud-session-"));
    stateDir = join(tmpDir, "state");
    transcript = join(tmpDir, "sess1.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ timestamp: ISO })}\n`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no transcript path → undefined", async () => {
    expect(await loadSessionStart("sess1", undefined, stateDir)).toBeUndefined();
  });

  test("missing transcript file → undefined", async () => {
    expect(await loadSessionStart("sess1", join(tmpDir, "nope.jsonl"), stateDir)).toBeUndefined();
  });

  test("derives epoch from first timestamped line", async () => {
    expect(await loadSessionStart("sess1", transcript, stateDir)).toBe(EPOCH);
  });

  test("skips lines without a timestamp", async () => {
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "meta" })}\n${JSON.stringify({ timestamp: ISO })}\n`,
    );
    expect(await loadSessionStart("sess1", transcript, stateDir)).toBe(EPOCH);
  });

  test("caches: second call survives transcript changes", async () => {
    await loadSessionStart("sess1", transcript, stateDir);
    writeFileSync(transcript, `${JSON.stringify({ timestamp: "2030-01-01T00:00:00Z" })}\n`);
    expect(await loadSessionStart("sess1", transcript, stateDir)).toBe(EPOCH);
  });

  test("no sessionId → derives without writing state", async () => {
    expect(await loadSessionStart(undefined, transcript, stateDir)).toBe(EPOCH);
    expect(await Bun.file(join(stateDir, "undefined.json")).exists()).toBe(false);
  });

  test("corrupt state file → re-derives from transcript", async () => {
    await loadSessionStart("sess1", transcript, stateDir);
    writeFileSync(join(stateDir, "sess1.json"), "not json");
    expect(await loadSessionStart("sess1", transcript, stateDir)).toBe(EPOCH);
  });

  test("versionless state file is honored and normalized", async () => {
    await loadSessionStart("sess1", transcript, stateDir);
    const statePath = join(stateDir, "sess1.json");
    writeFileSync(statePath, JSON.stringify({ sessionStart: 12_345 }));
    expect(await loadSessionStart("sess1", transcript, stateDir)).toBe(12_345);
    expect(await Bun.file(statePath).json()).toEqual({ version: 1, sessionStart: 12_345 });
  });
});
