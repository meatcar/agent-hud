#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveTtlSecs } from "./cache-ttl.ts";
import { HELPER_FLAG, runHelper, spawnHelpers } from "./cmd-helper.ts";
import { type CustomPass, customPass, resolveCommands } from "./commands.ts";
import { type AgentHudConfig, loadConfig, referencedCommandIds } from "./config.ts";
import { MAX_CMD_SPAWNS_PER_RENDER, MS_PER_SEC } from "./constants.ts";
import {
  contentFingerprint,
  deriveSession,
  flattenRateLimits,
  parseSectionArgs,
  parseStatusJson,
  selectOutput,
} from "./core.ts";
import { type SectionName, buildLine1, buildLine2 } from "./fields.ts";
import { maybeGc } from "./gc.ts";
import { msToNextMinute } from "./helpers.ts";
import { renderClockGroup } from "./powerline.ts";
import { makeBucket, mergeWithSharedDb, renderChanged } from "./rate-limits.ts";
import { adaptClaudeCodeStatus } from "./protocols/claude-code.ts";
import { loadSessionStart } from "./session.ts";
import { type Drift, findRepo, getDrift, renderDrift, repoLabel } from "./vcs.ts";

const STATE_DIR = process.env.AGENT_HUD_STATE_DIR ?? join(homedir(), ".claude", "agent-hud-state");
const SHARED_DB_PATH = join(STATE_DIR, "shared.db");
// Captured here, not in a helper module: this is the file carrying the argv
// Dispatch below, in every install shape (dev, bun link, bundle, Nix wrapper).
const SELF_PATH = import.meta.path;
const EMPTY_CUSTOM: ReadonlyMap<string, string> = new Map();

const parseStdin = async (): Promise<unknown> => parseStatusJson(await Bun.stdin.text());

// Idle re-renders (refreshInterval ticks with no content change) sleep to the
// Next minute boundary before printing, so time-derived labels — clock, TTL
// Countdown, burn ETAs — land exactly on :00. Event renders print immediately.
// AGENT_HUD_NO_ALIGN opts out (bench re-runs identical fixtures).
const alignedNow = async (sessionId: string | undefined, contentFp: string): Promise<number> => {
  const idle =
    !process.env.AGENT_HUD_NO_ALIGN &&
    sessionId !== undefined &&
    !renderChanged(SHARED_DB_PATH, sessionId, contentFp);
  if (idle) {
    await Bun.sleep(msToNextMinute(Date.now()));
  }
  return Math.floor(Date.now() / MS_PER_SEC);
};

const startDrift = (repo: ReturnType<typeof findRepo>): Promise<Drift | undefined> =>
  repo !== undefined ? getDrift(repo) : Promise.resolve(undefined);

// A broken config must not blank the built-in sections: report it once on
// Stderr and fall back to the default layout.
const resolveConfig = async (
  cliSections: SectionName[] | undefined,
): Promise<AgentHudConfig | undefined> => {
  if (cliSections !== undefined) return undefined;
  try {
    return await loadConfig();
  } catch (error) {
    process.stderr.write(
      `agent-hud: ignoring config (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return undefined;
  }
};

const resolveRenderNow = (
  cliSections: SectionName[] | undefined,
  sessionId: string | undefined,
  fingerprint: string,
): Promise<number> =>
  cliSections === undefined
    ? alignedNow(sessionId, fingerprint)
    : Promise.resolve(Math.floor(Date.now() / MS_PER_SEC));

// One shared-DB open serves both the rate-limit merge and the custom command
// Cache pass; refresh helpers are spawned only after that handle is closed.
// No referenced commands (every default and CLI render) means no cache query,
// No lease, and no spawn: the pass callback is never handed to the DB open.
const customPassFor = (
  config: AgentHudConfig | undefined,
  cwd: string,
  now: number,
): ((db: Database) => CustomPass) | undefined => {
  const resolved =
    config === undefined
      ? []
      : resolveCommands(config.commands, referencedCommandIds(config.layout), cwd);
  if (resolved.length === 0) return undefined;
  return (db) => customPass(db, resolved, now, MAX_CMD_SPAWNS_PER_RENDER);
};

const mergeAndRefresh = (
  config: AgentHudConfig | undefined,
  opts: Parameters<typeof mergeWithSharedDb>[1],
  cwd: string,
): ReturnType<typeof mergeWithSharedDb<CustomPass>> => {
  const merged = mergeWithSharedDb<CustomPass>(
    SHARED_DB_PATH,
    opts,
    customPassFor(config, cwd, opts.now),
  );
  const tasks = merged.extra?.tasks ?? [];
  if (tasks.length > 0) {
    spawnHelpers(SELF_PATH, SHARED_DB_PATH, tasks, cwd);
  }
  return merged;
};

const main = async (): Promise<void> => {
  const cliSections = parseSectionArgs(process.argv.slice(2));
  const config = await resolveConfig(cliSections);
  const fields = adaptClaudeCodeStatus(await parseStdin());
  const cwd = fields.projectDir ?? process.cwd();
  const repo = findRepo(cwd);
  const driftPromise = startDrift(repo);
  const { sessionId, session } = deriveSession(fields);
  const [sessionStart] = await Promise.all([
    loadSessionStart(sessionId, fields.transcriptPath, STATE_DIR),
    mkdir(STATE_DIR, { recursive: true }),
  ]);
  const { rateLimits, lastActivity, extra } = mergeAndRefresh(
    config,
    {
      stdin: {
        fiveHour: makeBucket(fields.fiveHourPct, fields.fiveHourReset),
        sevenDay: makeBucket(fields.sevenDayPct, fields.sevenDayReset),
      },
      session,
      now: Math.floor(Date.now() / MS_PER_SEC),
    },
    cwd,
  );
  const custom = extra?.outputs ?? EMPTY_CUSTOM;
  const line2Params = {
    repoOut: repoLabel(repo, cwd),
    driftOut: renderDrift(await driftPromise),
    worktreeBranch: fields.worktreeBranch,
  };
  const line2 = buildLine2(line2Params);
  const now = await resolveRenderNow(
    cliSections,
    sessionId,
    contentFingerprint(fields, line2, config, custom),
  );
  const line1Params = {
    ...fields,
    ...flattenRateLimits(rateLimits),
    sessionStart,
    now,
    ttlSecs: resolveTtlSecs(process.env, rateLimits),
    lastActivity,
  };
  process.stdout.write(
    selectOutput(
      { ...line1Params, ...line2Params },
      cliSections,
      config,
      custom,
      `${buildLine1(line1Params)}\n${line2}`,
    ),
  );
  await maybeGc(SHARED_DB_PATH, STATE_DIR, now);
};

if (import.meta.main) {
  if (process.argv[2] === HELPER_FLAG) {
    // Helper mode never prints and never reaches main(), so it cannot fall
    // Into the clock fallback or recurse into another spawn.
    await runHelper(process.argv[3] ?? "").catch(() => {});
    process.exit(0);
  }
  try {
    await main();
  } catch {
    // A statusline must always print something; fall back to the bare clock.
    const now = Math.floor(Date.now() / MS_PER_SEC);
    process.stdout.write(renderClockGroup(new Date(now * MS_PER_SEC)));
  }
}
