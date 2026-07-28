#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { resolveTtlSecs } from "./cache-ttl.ts";
import { type Layout, loadLayout } from "./config.ts";
import { MS_PER_SEC } from "./constants.ts";
import {
  type Fields,
  type SectionName,
  buildLine1,
  buildLine2,
  extractFields,
  isSectionName,
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

const resolveConfiguredLayout = (
  cliSections: SectionName[] | undefined,
): Promise<Layout | undefined> =>
  cliSections === undefined ? loadLayout() : Promise.resolve(undefined);

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
  configuredLayout: Layout | undefined,
  defaultOutput: string,
): string => {
  if (cliSections !== undefined) return renderSections(params, cliSections);
  if (configuredLayout !== undefined) {
    return configuredLayout.map((sections) => renderSections(params, sections)).join("\n");
  }
  return defaultOutput;
};

const main = async (): Promise<void> => {
  const cliSections = parseSectionArgs(process.argv.slice(2));
  const configuredLayout = await resolveConfiguredLayout(cliSections);
  const fields = extractFields(await parseStdin());
  const cwd = fields.projectDir ?? process.cwd();
  const repo = findRepo(cwd);
  const driftPromise = startDrift(repo);
  const { sessionId, session } = buildSession(fields);
  const [sessionStart] = await Promise.all([
    loadSessionStart(sessionId, fields.transcriptPath, STATE_DIR),
    mkdir(STATE_DIR, { recursive: true }),
  ]);
  const { rateLimits, lastActivity } = mergeWithSharedDb(SHARED_DB_PATH, {
    stdin: {
      fiveHour: makeBucket(fields.fiveHourPct, fields.fiveHourReset),
      sevenDay: makeBucket(fields.sevenDayPct, fields.sevenDayReset),
    },
    session,
    now: Math.floor(Date.now() / MS_PER_SEC),
  });
  const line2Params = {
    repoOut: repoLabel(repo, cwd),
    driftOut: renderDrift(await driftPromise),
    worktreeBranch: fields.worktreeBranch,
  };
  const line2 = buildLine2(line2Params);
  const now = await resolveRenderNow(
    cliSections,
    sessionId,
    JSON.stringify({ fields, line2, configuredLayout }),
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
      configuredLayout,
      `${buildLine1(line1Params)}\n${line2}`,
    ),
  );
  await maybeGc(SHARED_DB_PATH, STATE_DIR, now);
};

if (import.meta.main) {
  try {
    await main();
  } catch {
    // A statusline must always print something; fall back to the bare clock.
    process.stdout.write(renderClockGroup(new Date()));
  }
}
