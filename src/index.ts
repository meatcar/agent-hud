#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { resolveTtlSecs } from "./cache-ttl.ts";
import { HELPER_FLAG, runHelper, spawnHelpers } from "./cmd-helper.ts";
import { type CustomPass, customPass, resolveCommands } from "./commands.ts";
import { type AgentHudConfig, loadConfig, referencedCommandIds } from "./config.ts";
import { MAX_CMD_SPAWNS_PER_RENDER, MS_PER_SEC } from "./constants.ts";
import {
  type Fields,
  type SectionName,
  buildLine1,
  buildLine2,
  extractFields,
  isSectionName,
  renderLayoutLine,
  renderSections,
} from "./fields.ts";
import { maybeGc } from "./gc.ts";
import { cacheHitPct, msToNextMinute } from "./helpers.ts";
import { renderClockGroup } from "./powerline.ts";
import {
  type Bucket,
  type RateLimitsV1,
  type SessionInfo,
  makeBucket,
  mergeWithSharedDb,
  renderChanged,
} from "./rate-limits.ts";
import { loadSessionStart } from "./session.ts";
import { type Drift, findRepo, getDrift, renderDrift, repoLabel } from "./vcs.ts";

const STATE_DIR = process.env.AGENT_HUD_STATE_DIR ?? join(homedir(), ".claude", "agent-hud-state");
const SHARED_DB_PATH = join(STATE_DIR, "shared.db");
// Captured here, not in a helper module: this is the file carrying the argv
// Dispatch below, in every install shape (dev, bun link, bundle, Nix wrapper).
const SELF_PATH = import.meta.path;
const EMPTY_CUSTOM: ReadonlyMap<string, string> = new Map();

const parseSectionArgs = (args: string[]): SectionName[] | undefined => {
  if (args.length === 0) return undefined;
  const unknown = args.find((arg) => !isSectionName(arg));
  if (unknown !== undefined) throw new Error(`Unknown section: ${unknown}`);
  return args.filter(isSectionName);
};

const parseStdin = async (): Promise<unknown> => {
  const input = await Bun.stdin.text();
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Invalid statusline JSON");
  }
};

const buildSession = (
  fields: Fields,
): { sessionId: string | undefined; session: SessionInfo | undefined } => {
  const sessionId = fields.transcriptPath ? basename(fields.transcriptPath, ".jsonl") : undefined;
  const hitPct = cacheHitPct(fields.cacheRead, fields.cacheCreation, fields.inputTokens);
  const fingerprint = `${fields.cacheRead}:${fields.cacheCreation}:${fields.inputTokens}`;
  const session =
    sessionId !== undefined && hitPct !== undefined ? { sessionId, fingerprint } : undefined;
  return { sessionId, session };
};

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

const bucketFields = (
  bucket: Bucket | undefined,
): { pct: number | undefined; resetsAt: number | undefined } => ({
  pct: bucket?.pct,
  resetsAt: bucket?.resetsAt,
});

// Flatten merged buckets into the line-1 param names
const limitParams = (
  rateLimits: RateLimitsV1,
): Pick<
  Parameters<typeof buildLine1>[0],
  "fiveHourPct" | "fiveHourReset" | "sevenDayPct" | "sevenDayReset"
> => {
  const fiveHour = bucketFields(rateLimits.fiveHour);
  const sevenDay = bucketFields(rateLimits.sevenDay);
  return {
    fiveHourPct: fiveHour.pct,
    fiveHourReset: fiveHour.resetsAt,
    sevenDayPct: sevenDay.pct,
    sevenDayReset: sevenDay.resetsAt,
  };
};

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
  contentFingerprint: string,
): Promise<number> =>
  cliSections === undefined
    ? alignedNow(sessionId, contentFingerprint)
    : Promise.resolve(Math.floor(Date.now() / MS_PER_SEC));

const renderOutput = (
  params: Parameters<typeof renderSections>[0],
  cliSections: SectionName[] | undefined,
  config: AgentHudConfig | undefined,
  custom: ReadonlyMap<string, string>,
  defaultOutput: string,
): string => {
  if (cliSections !== undefined) return renderSections(params, cliSections);
  if (config !== undefined) {
    return config.layout.map((items) => renderLayoutLine(params, custom, items)).join("\n");
  }
  return defaultOutput;
};

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

// The rendered custom *text* enters the fingerprint, not its freshness: a
// Background refresh producing identical text stays idle, a changed one
// Bypasses the minute-boundary sleep.
const contentFingerprint = (
  fields: Fields,
  line2: string,
  config: AgentHudConfig | undefined,
  custom: ReadonlyMap<string, string>,
): string =>
  JSON.stringify({
    fields,
    line2,
    configuredLayout: config?.layout,
    custom: [...custom.values()],
  });

const main = async (): Promise<void> => {
  const cliSections = parseSectionArgs(process.argv.slice(2));
  const config = await resolveConfig(cliSections);
  const fields = extractFields(await parseStdin());
  const cwd = fields.projectDir ?? process.cwd();
  const repo = findRepo(cwd);
  const driftPromise = startDrift(repo);
  const { sessionId, session } = buildSession(fields);
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
    ...limitParams(rateLimits),
    sessionStart,
    now,
    ttlSecs: resolveTtlSecs(process.env, rateLimits),
    lastActivity,
  };
  process.stdout.write(
    renderOutput(
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
    process.stdout.write(renderClockGroup(new Date()));
  }
}
