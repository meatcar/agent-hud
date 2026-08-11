import type { Database } from "bun:sqlite";

import {
  CMD_LEASE_GRACE_SECS,
  CMD_LEASE_SKEW_SECS,
  DEFAULT_CMD_TIMEOUT_MS,
  DEFAULT_CMD_TTL_SECS,
  MAX_CMD_TIMEOUT_MS,
  MAX_CMD_TTL_SECS,
  MS_PER_SEC,
} from "./constants.ts";
import { isObject } from "./json.ts";
import { sanitizeOutput } from "./sanitize.ts";

export interface CustomCommand {
  id: string;
  argv: string[];
  timeoutMs: number;
  ttlSecs: number;
}

export type CustomCommands = ReadonlyMap<string, CustomCommand>;

export interface CmdCacheEntry {
  output: string;
  updatedAt: number;
  leaseUntil: number;
  leaseToken: string;
}

export interface ResolvedCommand {
  cmd: CustomCommand;
  key: string;
}

export interface CmdRefreshTask {
  id: string;
  key: string;
  token: string;
  cmd: CustomCommand;
}

export interface CustomPass {
  outputs: ReadonlyMap<string, string>;
  tasks: readonly CmdRefreshTask[];
}

export const CMDCACHE_PREFIX = "cmdcache:";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const parseBound = (raw: unknown, fallback: number, max: number, fail: () => never): number => {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) fail();
  return raw;
};

const parseCommand = (id: string, raw: unknown): CustomCommand => {
  if (!isObject(raw) || Array.isArray(raw)) {
    throw new Error(`commands.${id} must be a table`);
  }
  if (typeof raw.argv === "string") {
    throw new Error(
      `commands.${id}.argv must be an array of strings (shell strings are not supported)`,
    );
  }
  const rawArgv: unknown = raw.argv;
  const argv = Array.isArray(rawArgv)
    ? rawArgv.filter((arg: unknown): arg is string => typeof arg === "string" && arg !== "")
    : [];
  if (!Array.isArray(rawArgv) || rawArgv.length === 0 || argv.length !== rawArgv.length) {
    throw new Error(`commands.${id}.argv must be a non-empty array of strings`);
  }
  const timeoutMs = parseBound(raw.timeoutMs, DEFAULT_CMD_TIMEOUT_MS, MAX_CMD_TIMEOUT_MS, () => {
    throw new Error(
      `commands.${id}.timeoutMs must be an integer between 1 and ${MAX_CMD_TIMEOUT_MS}`,
    );
  });
  const ttlSecs = parseBound(raw.ttlSecs, DEFAULT_CMD_TTL_SECS, MAX_CMD_TTL_SECS, () => {
    throw new Error(`commands.${id}.ttlSecs must be an integer between 1 and ${MAX_CMD_TTL_SECS}`);
  });
  return { id, argv, timeoutMs, ttlSecs };
};

export const parseCommandsTable = (raw: unknown): Map<string, CustomCommand> => {
  const commands = new Map<string, CustomCommand>();
  if (raw === undefined) return commands;
  if (!isObject(raw) || Array.isArray(raw)) {
    throw new Error("commands must be a table");
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (!ID_RE.test(id)) {
      throw new Error(`Invalid command id: ${id}`);
    }
    commands.set(id, parseCommand(id, entry));
  }
  return commands;
};

// Keys are per-cwd and per-config so two repos, or an edited argv, never serve
// Each other's cached text; superseded rows simply age out via GC.
export const cacheKey = (id: string, cmd: CustomCommand, cwd: string): string => {
  const disc = Bun.hash
    .wyhash(`${cwd}\u0000${JSON.stringify(cmd.argv)}\u0000${cmd.timeoutMs}\u0000${cmd.ttlSecs}`)
    .toString(36);
  return `${CMDCACHE_PREFIX}${id}:${disc}`;
};

export const resolveCommands = (
  commands: CustomCommands,
  ids: readonly string[],
  cwd: string,
): ResolvedCommand[] => {
  const resolved: ResolvedCommand[] = [];
  for (const id of ids) {
    const cmd = commands.get(id);
    if (cmd !== undefined) {
      resolved.push({ cmd, key: cacheKey(id, cmd, cwd) });
    }
  }
  return resolved;
};

// The longest lease any well-formed claim can ask for.
export const MAX_LEASE_SECS = Math.ceil(MAX_CMD_TIMEOUT_MS / MS_PER_SEC) + CMD_LEASE_GRACE_SECS;

// How far ahead of a caller's `now` a lease stamp may sit and still be
// Plausible: a peer's maximum lease plus skew slack. Beyond it the stamp can
// Only come from a clock jump or a corrupted row, so it is treated as stale.
// Both the claim path and GC use this horizon so their notions of "live lease"
// Stay identical.
export const LEASE_FUTURE_HORIZON_SECS = MAX_LEASE_SECS + CMD_LEASE_SKEW_SECS;

const freshValue = (now: number, until: number, token: string): string =>
  JSON.stringify({ output: "", updatedAt: now, leaseUntil: until, leaseToken: token });

const newLeaseToken = (): string => crypto.randomUUID();

export const readCmdEntry = (db: Database, key: string): CmdCacheEntry | undefined => {
  try {
    const row = db.query<{ val: string }, [string]>("SELECT v AS val FROM kv WHERE k=?").get(key);
    if (!row) return undefined;
    const parsed: unknown = JSON.parse(row.val);
    if (!isObject(parsed) || Array.isArray(parsed)) return undefined;
    return {
      output: typeof parsed.output === "string" ? parsed.output : "",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      leaseUntil: typeof parsed.leaseUntil === "number" ? parsed.leaseUntil : 0,
      leaseToken: typeof parsed.leaseToken === "string" ? parsed.leaseToken : "",
    };
  } catch {
    return undefined;
  }
};

// Every JSON function sits inside a CASE arm that is only reached once
// Json_valid has already proven the row parses, so a malformed row can never
// Raise "malformed JSON" mid-statement.
const CLAIM_SQL = `INSERT INTO kv (k, v) VALUES (?1, ?2)
ON CONFLICT(k) DO UPDATE SET v = CASE
    WHEN json_valid(kv.v) = 0 THEN ?2
    WHEN json_type(kv.v) <> 'object' THEN ?2
    ELSE json_object(
      'output', CASE WHEN json_type(kv.v, '$.output') = 'text'
                     THEN json_extract(kv.v, '$.output') ELSE '' END,
      'updatedAt', ?5,
      'leaseUntil', ?3,
      'leaseToken', ?4)
  END
WHERE CASE
    WHEN json_valid(kv.v) = 0 THEN 1
    WHEN json_type(kv.v) <> 'object' THEN 1
    WHEN json_type(kv.v, '$.leaseUntil') IS NULL THEN 1
    WHEN json_type(kv.v, '$.leaseUntil') NOT IN ('integer', 'real') THEN 1
    WHEN json_extract(kv.v, '$.leaseUntil') <= ?5 THEN 1
    WHEN json_extract(kv.v, '$.leaseUntil') > ?6 THEN 1
    ELSE 0
  END`;

// One statement is the only cross-process de-duplication point: cold insert,
// Reclaim of an expired or implausibly future lease, and repair of a malformed
// Row all resolve inside the same atomic write, so there is no window in which
// Two renders can both believe they won. The lease self-expires at leaseUntil,
// So a killed helper needs no cleanup.
export const claimLease = (
  db: Database,
  key: string,
  now: number,
  leaseSecs: number,
  token: string,
): boolean =>
  db
    .query(CLAIM_SQL)
    .run(
      key,
      freshValue(now, now + leaseSecs, token),
      now + leaseSecs,
      token,
      now,
      now + LEASE_FUTURE_HORIZON_SECS,
    ).changes === 1;

const RESULT_SQL = (setOutput: boolean): string =>
  `UPDATE kv SET v = json_set(v, ${setOutput ? "'$.output', ?3, " : ""}'$.updatedAt', ?4, '$.leaseUntil', 0, '$.leaseToken', '')
WHERE k = ?1 AND CASE
    WHEN json_valid(v) = 0 THEN 0
    WHEN json_type(v) <> 'object' THEN 0
    ELSE json_extract(v, '$.leaseToken') = ?2
  END`;

// A failed/timed-out command stamps updatedAt without touching output: the
// Previous good value keeps serving for another ttl and no respawn storm forms.
export const writeCmdResult = (
  db: Database,
  key: string,
  token: string,
  output: string | undefined,
  now: number,
): boolean =>
  db.query(RESULT_SQL(output !== undefined)).run(key, token, output ?? "", now).changes === 1;

const EMPTY_OUTPUTS: ReadonlyMap<string, string> = new Map();

export const customPass = (
  db: Database,
  resolved: readonly ResolvedCommand[],
  now: number,
  maxSpawns: number,
): CustomPass => {
  if (resolved.length === 0) return { outputs: EMPTY_OUTPUTS, tasks: [] };
  const outputs = new Map<string, string>();
  const tasks: CmdRefreshTask[] = [];
  for (const { cmd, key } of resolved) {
    try {
      const entry = readCmdEntry(db, key);
      outputs.set(cmd.id, sanitizeOutput(entry?.output ?? ""));
      const stale = entry === undefined || now - entry.updatedAt >= cmd.ttlSecs;
      if (!stale || tasks.length >= maxSpawns) continue;
      const token = newLeaseToken();
      const leaseSecs = Math.ceil(cmd.timeoutMs / MS_PER_SEC) + CMD_LEASE_GRACE_SECS;
      if (claimLease(db, key, now, leaseSecs, token)) {
        tasks.push({ id: cmd.id, key, token, cmd });
      }
    } catch {
      // A broken row or DB must degrade to an empty section, never a lost HUD.
      outputs.set(cmd.id, "");
    }
  }
  return { outputs, tasks };
};
