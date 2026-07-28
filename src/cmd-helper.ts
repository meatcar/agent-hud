import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CmdRefreshTask } from "./commands.ts";
import { CMDCACHE_PREFIX, writeCmdResult } from "./commands.ts";
import { MAX_CMD_STDOUT_BYTES, MAX_CMD_TIMEOUT_MS, MS_PER_SEC } from "./constants.ts";
import { isObject } from "./json.ts";
import { openDb } from "./rate-limits.ts";
import { sanitizeOutput } from "./sanitize.ts";

export const HELPER_FLAG = "--agent-hud-run-command";
export const HELPER_ENV = "AGENT_HUD_CMD_HELPER";

export interface HelperPayload {
  v: 1;
  dbPath: string;
  key: string;
  token: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

export type HelperEnv = Readonly<Record<string, string | undefined>>;

export const encodePayload = (payload: HelperPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

// An empty argv element is never meaningful and would silently pass an empty
// String to execve, so it is rejected rather than dropped.
const isValidTimeout = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CMD_TIMEOUT_MS;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item !== "");

export const decodePayload = (encoded: string): HelperPayload | undefined => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isObject(parsed)) return undefined;
    const { v, dbPath, key, token, argv, cwd, timeoutMs } = parsed;
    if (
      v !== 1 ||
      typeof dbPath !== "string" ||
      typeof key !== "string" ||
      typeof token !== "string" ||
      typeof cwd !== "string" ||
      !isValidTimeout(timeoutMs) ||
      !key.startsWith(CMDCACHE_PREFIX) ||
      !isStringArray(argv)
    ) {
      return undefined;
    }
    return { v: 1, dbPath, key, token, argv, cwd, timeoutMs };
  } catch {
    return undefined;
  }
};

// Detached + all-ignore stdio + unref together are what let the parent exit
// Immediately: any piped stream would keep the parent's event loop alive.
export const spawnHelpers = (
  selfPath: string,
  dbPath: string,
  tasks: readonly CmdRefreshTask[],
  cwd: string,
  env: HelperEnv = process.env,
): number => {
  if (env[HELPER_ENV]) return 0;
  let spawned = 0;
  for (const task of tasks) {
    try {
      const encoded = encodePayload({
        v: 1,
        dbPath,
        key: task.key,
        token: task.token,
        argv: task.cmd.argv,
        cwd,
        timeoutMs: task.cmd.timeoutMs,
      });
      const proc = Bun.spawn([process.execPath, selfPath, HELPER_FLAG, encoded], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
        env: { ...env, [HELPER_ENV]: "1" },
      });
      proc.unref();
      spawned += 1;
    } catch {
      // A refresh that cannot start just leaves the lease to expire.
    }
  }
  return spawned;
};

// Direct argv only, never a shell. Stdout is bounded in-process rather than
// Trusting maxBuffer's streaming semantics; stderr and stdin are ignored.
//
// Only the first MAX_CMD_STDOUT_BYTES bytes are ever retained — a chunk that
// Straddles the cap is sliced, never kept whole — so the same command always
// Yields the same prefix no matter how the pipe happens to chunk it. Decoding
// Is incremental and the trailing partial code point is never flushed, so the
// Byte cut cannot manufacture a U+FFFD. Hitting the cap is our own kill, not a
// Command failure, so the prefix is returned; unrelated nonzero exits and
// Timeouts still fail.
export const runUserCommand = async (
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> => {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const decoder = new TextDecoder("utf-8");
    let out = "";
    let remaining = MAX_CMD_STDOUT_BYTES;
    let capped = false;
    for await (const chunk of proc.stdout) {
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      out += decoder.decode(slice, { stream: true });
      remaining -= slice.byteLength;
      if (remaining === 0) {
        capped = true;
        proc.kill("SIGKILL");
        break;
      }
    }
    const code = await proc.exited;
    if (capped) return out;
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

// The DB is opened only after the child has exited, so no SQLite lock is ever
// Held across user-command execution.
export const runHelper = async (encoded: string): Promise<void> => {
  const payload = decodePayload(encoded);
  if (payload === undefined) return;
  await mkdir(dirname(payload.dbPath), { recursive: true });
  const raw = await runUserCommand(payload.argv, payload.cwd, payload.timeoutMs);
  const output = raw === undefined ? undefined : sanitizeOutput(raw);
  const db = openDb(payload.dbPath);
  try {
    writeCmdResult(db, payload.key, payload.token, output, Math.floor(Date.now() / MS_PER_SEC));
  } finally {
    db.close();
  }
};
