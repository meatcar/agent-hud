import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROCESS_WORKER_PATH = fileURLToPath(
  new URL("../fixtures/process-worker.ts", import.meta.url),
);

export interface ProcessResult {
  code: number;
  out: string;
  err: string;
}

const waitForFiles = async (paths: readonly string[], deadline: number): Promise<boolean> => {
  if (paths.every(existsSync)) return true;
  if (Date.now() >= deadline) return false;
  await Bun.sleep(10);
  return waitForFiles(paths, deadline);
};

export const runSynchronized = async (
  root: string,
  args: readonly (readonly string[])[],
  timeoutMs = 15_000,
): Promise<ProcessResult[]> => {
  const deadline = Date.now() + timeoutMs;
  const syncDir = mkdtempSync(join(root, "sync-"));
  const readyDir = join(syncDir, "ready");
  const goPath = join(syncDir, "go");
  mkdirSync(readyDir, { recursive: true });
  const readyPaths = args.map((_, index) => join(readyDir, String(index)));
  const processes: Bun.ReadableSubprocess[] = [];
  try {
    for (const [index, workerArgs] of args.entries()) {
      processes.push(
        Bun.spawn(
          [process.execPath, PROCESS_WORKER_PATH, ...workerArgs, readyPaths[index] ?? "", goPath],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
    }
  } catch (error) {
    for (const process of processes) {
      try {
        process.kill("SIGKILL");
      } catch {
        // Already reaped.
      }
    }
    await Promise.all(
      processes.map((process) =>
        Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]),
      ),
    );
    throw error;
  }
  const collected = Promise.all(
    processes.map(async (process) => {
      const [out, err, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { code, out, err };
    }),
  );
  let timedOut = false;
  const killAll = (): void => {
    for (const process of processes) {
      try {
        process.kill("SIGKILL");
      } catch {
        // Already reaped.
      }
    }
  };
  const timer = setTimeout(
    () => {
      timedOut = true;
      killAll();
    },
    Math.max(0, deadline - Date.now()),
  );

  try {
    const ready = await waitForFiles(readyPaths, deadline);
    if (!ready) {
      timedOut = true;
      killAll();
      const results = await collected;
      throw new Error(
        `workers did not reach the synchronization barrier: ${JSON.stringify(results)}`,
      );
    }
    writeFileSync(goPath, "go\n");
    const results = await collected;
    if (timedOut || Date.now() > deadline) {
      throw new Error(`workers exceeded the hard deadline: ${JSON.stringify(results)}`);
    }
    return results;
  } finally {
    clearTimeout(timer);
    killAll();
    await collected;
  }
};

export const expectCleanProcesses = (results: readonly ProcessResult[]): void => {
  const failures = results.filter((result) => result.code !== 0 || result.err !== "");
  if (failures.length > 0) {
    throw new Error(`worker failures: ${JSON.stringify(failures)}`);
  }
};
