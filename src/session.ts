import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { STATE_VERSION, TRANSCRIPT_SCAN_BYTES } from "./constants.ts";
import { toEpoch } from "./helpers.ts";
import { getNumber, getString } from "./json.ts";

interface CachedState {
  version: 1;
  sessionStart: number;
}

const tryParseTimestamp = (line: string): number | undefined => {
  if (!line.includes('"timestamp"')) {
    return undefined;
  }
  try {
    return toEpoch(getString(JSON.parse(line) as unknown, "timestamp"));
  } catch {
    return undefined;
  }
};

const firstTimestampEpoch = async (path: string): Promise<number | undefined> => {
  try {
    const text = await Bun.file(path).slice(0, TRANSCRIPT_SCAN_BYTES).text();
    for (const line of text.split("\n")) {
      const epoch = tryParseTimestamp(line);
      if (epoch !== undefined) {
        return epoch;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const parseStateFields = (raw: unknown): CachedState | undefined => {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const sessionStart = getNumber(raw, "sessionStart");
  return sessionStart !== undefined ? { version: 1, sessionStart } : undefined;
};

const parseCachedState = async (statePath: string): Promise<CachedState | undefined> => {
  try {
    const raw: unknown = await Bun.file(statePath).json();
    const state = parseStateFields(raw);
    if (state === undefined) {
      return undefined;
    }
    if (getNumber(raw, "version") !== STATE_VERSION) {
      await Bun.write(statePath, JSON.stringify(state));
    }
    return state;
  } catch {
    return undefined;
  }
};

const writeAndReturnEpoch = async (
  statePath: string,
  transcriptPath: string,
): Promise<number | undefined> => {
  const epoch = await firstTimestampEpoch(transcriptPath);
  if (epoch === undefined) {
    return undefined;
  }
  await mkdir(dirname(statePath), { recursive: true });
  await Bun.write(statePath, JSON.stringify({ version: STATE_VERSION, sessionStart: epoch }));
  return epoch;
};

export const loadSessionStart = async (
  sessionId: string | undefined,
  transcriptPath: string | undefined,
  stateDir: string,
): Promise<number | undefined> => {
  if (!transcriptPath) {
    return undefined;
  }
  if (!sessionId) {
    return firstTimestampEpoch(transcriptPath);
  }
  const statePath = join(stateDir, `${sessionId}.json`);
  const cached = await parseCachedState(statePath);
  if (cached !== undefined) {
    return cached.sessionStart;
  }
  return writeAndReturnEpoch(statePath, transcriptPath);
};
