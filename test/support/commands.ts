import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readCmdEntry } from "../../src/commands.ts";

export const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/cmd-fixture.ts", import.meta.url));

// Every fixture command runs the current Bun binary against a committed script,
// So tests never depend on a shell or on coreutils being installed.
export const fixtureArgv = (...args: string[]): string[] => [
  process.execPath,
  FIXTURE_PATH,
  ...args,
];

const readCachedEntry = (dbPath: string, key: string) => {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    return readCmdEntry(db, key);
  } catch {
    // The DB may not exist yet on the first poll.
    return undefined;
  } finally {
    db?.close();
  }
};

const poll = async <T>(
  read: () => T | undefined,
  done: (value: T) => boolean,
  deadline: number,
  intervalMs: number,
): Promise<T | undefined> => {
  const value = read();
  if (value !== undefined && done(value)) return value;
  if (Date.now() >= deadline) return undefined;
  await Bun.sleep(intervalMs);
  return poll(read, done, deadline, intervalMs);
};

// Bounded poll for a detached helper's write: no unbounded sleeps, and a
// Missing value after the deadline is reported rather than hanging the suite.
export const pollCachedOutput = async (
  dbPath: string,
  key: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<string | undefined> => {
  const entry = await poll(
    () => readCachedEntry(dbPath, key),
    (value) => value.output !== "",
    Date.now() + timeoutMs,
    intervalMs,
  );
  return entry?.output;
};

export const pollLeaseReleased = async (
  dbPath: string,
  key: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<boolean> =>
  (await poll(
    () => readCachedEntry(dbPath, key),
    (value) => value.leaseToken === "",
    Date.now() + timeoutMs,
    intervalMs,
  )) !== undefined;

export const pollPathExists = async (
  path: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<boolean> =>
  (await poll(
    () => (existsSync(path) ? true : undefined),
    (value) => value,
    Date.now() + timeoutMs,
    intervalMs,
  )) === true;
