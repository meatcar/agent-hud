#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { resolveTtlSecs } from "./cache-ttl.ts";
import { MS_PER_SEC } from "./constants.ts";
import { type Fields, buildLine1, buildLine2, extractFields } from "./fields.ts";
import { maybeGc } from "./gc.ts";
import { cacheHitPct, msToNextMinute } from "./helpers.ts";
import { renderClockGroup } from "./powerline.ts";
import { type SessionInfo, makeBucket, mergeWithSharedDb, renderChanged } from "./rate-limits.ts";
import { loadSessionStart } from "./session.ts";
import { findRepo, getDrift, renderDrift, repoLabel } from "./vcs.ts";

const STATE_DIR =
  process.env.AGENT_HUD_STATE_DIR ?? join(homedir(), ".claude", "agent-hud-state");
const SHARED_DB_PATH = join(STATE_DIR, "shared.db");

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

const main = async (): Promise<void> => {
  const fields = extractFields(JSON.parse(await Bun.stdin.text()));
  const cwd = fields.projectDir ?? process.cwd();
  const repo = findRepo(cwd);
  const driftPromise = repo !== undefined ? getDrift(repo) : Promise.resolve(undefined);
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
  const line2 = buildLine2({
    repoOut: repoLabel(repo, cwd),
    driftOut: renderDrift(await driftPromise),
    worktreeBranch: fields.worktreeBranch,
  });
  const now = await alignedNow(sessionId, JSON.stringify({ fields, line2 }));
  const line1 = buildLine1({
    ...fields,
    fiveHourPct: rateLimits.fiveHour?.pct,
    fiveHourReset: rateLimits.fiveHour?.resetsAt,
    sevenDayPct: rateLimits.sevenDay?.pct,
    sevenDayReset: rateLimits.sevenDay?.resetsAt,
    sessionStart,
    now,
    ttlSecs: resolveTtlSecs(process.env, rateLimits),
    lastActivity,
  });
  process.stdout.write(`${line1}\n${line2}`);
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
