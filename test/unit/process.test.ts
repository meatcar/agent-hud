import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "../../scripts/process.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/validation-process.ts", import.meta.url));

const expectFailure = async (run: Promise<unknown>, message: string): Promise<void> => {
  let failure: unknown;
  try {
    await run;
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof Error)) throw new Error("expected validation process failure");
  expect(failure.message).toContain(message);
};

const remainsAbsent = async (path: string, deadline: number): Promise<void> => {
  if (existsSync(path)) throw new Error(`unexpected marker: ${path}`);
  if (Date.now() >= deadline) return;
  await Bun.sleep(20);
  return remainsAbsent(path, deadline);
};

test("timeout kills the validation process group and returns within its grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-hud-process-test-"));
  try {
    const marker = join(root, "child-survived");
    const started = Date.now();
    await expectFailure(
      runProcess([process.execPath, FIXTURE, "tree-parent", marker], { timeoutMs: 50 }),
      "exceeded 50ms",
    );
    expect(Date.now() - started).toBeLessThan(2_500);
    await remainsAbsent(marker, Date.now() + 600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output limits cancel readers and bound process completion", async () => {
  const started = Date.now();
  await expectFailure(
    runProcess([process.execPath, FIXTURE, "flood"], {
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    }),
    "exceeded 1024 output bytes",
  );
  expect(Date.now() - started).toBeLessThan(2_500);
});
