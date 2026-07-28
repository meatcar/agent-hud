import { Database } from "bun:sqlite";

import { readCmdEntry } from "./commands.ts";

export const FIXTURE_PATH = new URL("cmd-fixture.ts", import.meta.url).pathname;

// Every fixture command runs the current Bun binary against a committed script,
// So tests never depend on a shell or on coreutils being installed.
export const fixtureArgv = (...args: string[]): string[] => [
  process.execPath,
  FIXTURE_PATH,
  ...args,
];

const readOutput = (dbPath: string, key: string): string | undefined => {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const entry = readCmdEntry(db, key);
    return entry !== undefined && entry.output !== "" ? entry.output : undefined;
  } catch {
    // The DB may not exist yet on the first poll.
    return undefined;
  } finally {
    db?.close();
  }
};

// Bounded poll for a detached helper's write: no unbounded sleeps, and a
// Missing value after the deadline is reported rather than hanging the suite.
export const pollCachedOutput = async (
  dbPath: string,
  key: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (): Promise<string | undefined> => {
    const found = readOutput(dbPath, key);
    if (found !== undefined || Date.now() >= deadline) return found;
    await Bun.sleep(intervalMs);
    return attempt();
  };
  return attempt();
};
