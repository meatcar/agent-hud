const POST_KILL_GRACE_MS = 2_000;
const OUTPUT_DRAIN_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface Capture {
  promise: Promise<void>;
  cancel: () => void;
  text: () => string;
  exceeded: () => boolean;
  failure: () => unknown;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

const capture = (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: () => void,
): Capture => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let overLimit = false;
  let readFailure: unknown;
  const readNext = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    if (length + value.length > maxBytes) {
      overLimit = true;
      onExceeded();
      await reader.cancel("validation output limit exceeded").catch(() => {});
      return;
    }
    chunks.push(value);
    length += value.length;
    return readNext();
  };
  const promise = readNext().catch((error: unknown) => {
    readFailure = error;
  });
  return {
    promise,
    cancel: () => {
      void reader.cancel("validation process finished").catch(() => {});
    },
    text: () => {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(bytes);
    },
    exceeded: () => overLimit,
    failure: () => readFailure,
  };
};

const waitFor = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> =>
  Promise.race([promise.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);

export const runProcess = async (
  argv: string[],
  options: ProcessOptions,
): Promise<ProcessResult> => {
  const grouped = process.platform === "linux" || process.platform === "darwin";
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    detached: grouped,
  });
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    if (grouped) {
      try {
        process.kill(-proc.pid, "SIGKILL");
        return;
      } catch {
        // Fall through when the group already exited or groups are unavailable.
      }
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  };
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = capture(proc.stdout, maxOutput, kill);
  const stderr = capture(proc.stderr, maxOutput, kill);
  const outcome = await Promise.race([
    proc.exited.then((code) => ({ kind: "exit" as const, code })),
    Bun.sleep(options.timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (outcome.kind === "timeout") {
    kill();
    stdout.cancel();
    stderr.cancel();
    await waitFor(proc.exited, POST_KILL_GRACE_MS);
    await waitFor(Promise.allSettled([stdout.promise, stderr.promise]), POST_KILL_GRACE_MS);
    throw new Error(`${argv[0]} exceeded ${options.timeoutMs}ms`);
  }

  const drained = await waitFor(
    Promise.allSettled([stdout.promise, stderr.promise]),
    OUTPUT_DRAIN_GRACE_MS,
  );
  if (!drained) {
    kill();
    stdout.cancel();
    stderr.cancel();
    await waitFor(proc.exited, POST_KILL_GRACE_MS);
    throw new Error(`${argv[0]} output pipes did not close within ${OUTPUT_DRAIN_GRACE_MS}ms`);
  }
  if (stdout.exceeded() || stderr.exceeded()) {
    kill();
    await waitFor(proc.exited, POST_KILL_GRACE_MS);
    throw new Error(`${argv[0]} exceeded ${maxOutput} output bytes`);
  }
  const readFailure = stdout.failure() ?? stderr.failure();
  if (readFailure !== undefined) {
    const message =
      readFailure instanceof Error
        ? readFailure.message
        : typeof readFailure === "string"
          ? readFailure
          : "non-Error reader failure";
    throw new Error(`${argv[0]} output capture failed: ${message}`, { cause: readFailure });
  }
  return { code: outcome.code, stdout: stdout.text(), stderr: stderr.text() };
};
