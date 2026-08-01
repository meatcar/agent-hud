import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cacheKey } from "../../src/commands.ts";
import { DEFAULT_CMD_TIMEOUT_MS, DEFAULT_CMD_TTL_SECS } from "../../src/constants.ts";
import { openDb } from "../../src/rate-limits.ts";
import {
  FIXTURE_PATH,
  pollCachedOutput,
  pollLeaseReleased,
  pollPathExists,
} from "../support/commands.ts";

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const CHILD_TIMEOUT_MS = 15_000;
const tempRoots = new Set<string>();

const tempDir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(path);
  return path;
};

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

const collectChild = async (
  proc: Bun.ReadableSubprocess,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<{ code: number; out: string; err: string }> => {
  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timedOut = false;
  const kill = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already reaped.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  try {
    const [out, err, code] = await collected;
    if (timedOut) throw new Error(`child exceeded ${timeoutMs}ms hard deadline`);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) kill();
    await proc.exited;
  }
};

const runStatusline = async (
  stdin: string,
  sections: string[] = [],
  env: Record<string, string> = {},
  entry = ENTRY,
): Promise<{ code: number; out: string; err: string }> => {
  const testDir = tempDir("agent-hud-idx-");
  const proc = Bun.spawn([process.execPath, entry, ...sections], {
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      AGENT_HUD_STATE_DIR: join(testDir, "state"),
      AGENT_HUD_CONFIG: join(testDir, "missing-config.toml"),
      AGENT_HUD_NO_ALIGN: "1",
      ...env,
    },
  });
  return collectChild(proc);
};

// Detached helpers are polled with a hard deadline; the per-test budget must
// Exceed that deadline so a slow machine reports a real failure, not a timeout.
const POLL_TEST_TIMEOUT_MS = 30_000;

const stdinFor = (projectDir: string): string =>
  JSON.stringify({
    workspace: { project_dir: projectDir },
    model: { id: "claude-fable-5" },
  });

const tomlList = (items: string[]): string =>
  `[ ${items.map((item) => JSON.stringify(item)).join(", ")} ]`;

const tomlArgv = (args: string[]): string => tomlList(args);

const writeConfig = (body: string): string => {
  const path = join(tempDir("agent-hud-config-"), "config.toml");
  writeFileSync(path, body);
  return path;
};

const customCmd = (id: string, args: string[]): string =>
  `[commands.${id}]\nargv = ${tomlArgv([process.execPath, FIXTURE_PATH, ...args])}\n`;

const expectedKey = (id: string, args: string[], cwd: string): string =>
  cacheKey(
    id,
    {
      id,
      argv: [process.execPath, FIXTURE_PATH, ...args],
      timeoutMs: DEFAULT_CMD_TIMEOUT_MS,
      ttlSecs: DEFAULT_CMD_TTL_SECS,
    },
    cwd,
  );

describe("agent-hud entrypoint", () => {
  test("malformed stdin still prints and exits 0", async () => {
    const { code, out } = await runStatusline("not json at all");
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });

  test("valid stdin renders two lines", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const { code, out } = await runStatusline(
      JSON.stringify({
        workspace: { project_dir: projectDir },
        model: { id: "claude-fable-5" },
        context_window: { remaining_percentage: 50 },
      }),
    );
    expect(code).toBe(0);
    expect(out.split("\n")).toHaveLength(2);
  });

  test("a held DB writer cannot stall process completion after HUD output", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const stateDir = tempDir("agent-hud-state-");
    const lock = openDb(join(stateDir, "shared.db"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      const result = await runStatusline(stdinFor(projectDir), [], {
        AGENT_HUD_STATE_DIR: stateDir,
      });
      const elapsed = performance.now() - started;
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expect(Bun.stripANSI(result.out)).toContain("fable-5");
      expect(result.out.split("\n")).toHaveLength(2);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });

  test("section arguments render only those sections in order", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const { code, out } = await runStatusline(
      JSON.stringify({
        workspace: { project_dir: projectDir },
        model: { id: "claude-fable-5" },
      }),
      ["vcs", "model"],
    );
    const plain = Bun.stripANSI(out);
    expect(code).toBe(0);
    expect(plain).toStartWith(`${basename(projectDir)} fable-5`);
    expect(plain).not.toContain("\n");
  });

  test("TOML config controls line layout", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const configPath = join(tempDir("agent-hud-config-"), "config.toml");
    writeFileSync(
      configPath,
      `
[layout]
lines = [
  ["vcs", "model"],
  ["context"],
]
`,
    );
    const { code, out } = await runStatusline(
      JSON.stringify({
        workspace: { project_dir: projectDir },
        model: { id: "claude-fable-5" },
        context_window: { remaining_percentage: 50 },
      }),
      [],
      { AGENT_HUD_CONFIG: configPath },
    );
    const lines = Bun.stripANSI(out).split("\n");
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`${basename(projectDir)} fable-5`);
    expect(lines[1]).toStartWith("50%");
  });

  test("CLI sections override the TOML layout", async () => {
    const configPath = join(tempDir("agent-hud-config-"), "config.toml");
    writeFileSync(
      configPath,
      `
[layout]
lines = [
  ["clock"],
]
`,
    );
    const { code, out } = await runStatusline(
      JSON.stringify({ model: { id: "claude-fable-5" } }),
      ["model"],
      { AGENT_HUD_CONFIG: configPath },
    );
    expect(code).toBe(0);
    expect(Bun.stripANSI(out)).toBe("fable-5");
  });
});

describe("custom command sections", () => {
  const runWithConfig = async (
    body: string,
    projectDir: string,
    stateDir: string,
  ): Promise<{ code: number; out: string; err: string }> =>
    runStatusline(stdinFor(projectDir), [], {
      AGENT_HUD_CONFIG: writeConfig(body),
      AGENT_HUD_STATE_DIR: stateDir,
    });

  test("an unknown cmd: CLI argument falls back to the clock, exit 0", async () => {
    const { code, out } = await runStatusline("{}", ["cmd:k8s"]);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("\n");
  });

  test("a malformed config emits one diagnostic and keeps the built-in layout", async () => {
    const { code, out, err } = await runStatusline(
      JSON.stringify({ model: { id: "claude-fable-5" } }),
      [],
      { AGENT_HUD_CONFIG: writeConfig('[layout]\nlines = [ ["weather"] ]\n') },
    );
    expect(code).toBe(0);
    expect(Bun.stripANSI(out)).toContain("fable-5");
    expect(out.split("\n")).toHaveLength(2);
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("Unknown section: weather");
  });

  test(
    "a cold render prints immediately, then a detached helper fills the cache",
    async () => {
      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const args = ["echo", 'prod-"cluster\\west'];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;

      const started = Date.now();
      const first = await runWithConfig(body, projectDir, stateDir);
      const elapsed = Date.now() - started;
      expect(first.code).toBe(0);
      // Stale/empty renders immediately: the parent never waits on the command.
      expect(Bun.stripANSI(first.out)).toBe("fable-5");
      expect(elapsed).toBeLessThan(5000);

      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe('prod-"cluster\\west');

      const second = await runWithConfig(body, projectDir, stateDir);
      expect(Bun.stripANSI(second.out)).toBe('fable-5 prod-"cluster\\west');
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "a blocked command never blocks the render",
    async () => {
      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const startedPath = join(stateDir, "started");
      const releasePath = join(stateDir, "release");
      const args = ["gate", startedPath, releasePath, "released"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:slow"])} ]\n\n${customCmd("slow", args)}`;
      const { code, out } = await runWithConfig(body, projectDir, stateDir);
      expect(code).toBe(0);
      expect(Bun.stripANSI(out)).toBe("fable-5");
      expect(await pollPathExists(startedPath)).toBe(true);
      expect(existsSync(releasePath)).toBe(false);
      writeFileSync(releasePath, "go\n");
      expect(
        await pollCachedOutput(join(stateDir, "shared.db"), expectedKey("slow", args, projectDir)),
      ).toBe("released");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "concurrent renders run the command exactly once",
    async () => {
      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const marker = join(stateDir, "ran.txt");
      const args = ["count", marker, "once"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;

      const renders = await Promise.all([
        runWithConfig(body, projectDir, stateDir),
        runWithConfig(body, projectDir, stateDir),
        runWithConfig(body, projectDir, stateDir),
      ]);
      for (const render of renders) {
        expect(render.code).toBe(0);
        expect(render.err).toBe("");
        expect(["fable-5", "fable-5 once"]).toContain(Bun.stripANSI(render.out));
      }
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("once");
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "a failing command renders empty and does not respawn while its empty result is fresh",
    async () => {
      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const marker = join(stateDir, "ran.txt");
      const args = ["count-fail", marker, "x"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:bad"])} ]\n\n${customCmd("bad", args)}`;
      const dbPath = join(stateDir, "shared.db");
      const key = expectedKey("bad", args, projectDir);

      const first = await runWithConfig(body, projectDir, stateDir);
      expect(Bun.stripANSI(first.out)).toBe("fable-5");
      expect(await pollLeaseReleased(dbPath, key)).toBe(true);
      const second = await runWithConfig(body, projectDir, stateDir);
      expect(second.code).toBe(0);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("an unreferenced command never executes", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const stateDir = tempDir("agent-hud-state-");
    const marker = join(stateDir, "ran.txt");
    const body = `[layout]\nlines = [ ${tomlList(["model"])} ]\n\n${customCmd("unused", ["count", marker, "x"])}`;
    const { code, out } = await runWithConfig(body, projectDir, stateDir);
    expect(code).toBe(0);
    expect(Bun.stripANSI(out)).toBe("fable-5");
    expect(existsSync(marker)).toBe(false);
    const db = new Database(join(stateDir, "shared.db"), { readonly: true });
    const rows = db.query("SELECT k FROM kv WHERE k LIKE 'cmdcache:%'").all();
    db.close();
    expect(rows).toHaveLength(0);
  });

  test("a render with no commands writes no cmdcache rows", async () => {
    const projectDir = tempDir("agent-hud-proj-");
    const stateDir = tempDir("agent-hud-state-");
    await runStatusline(stdinFor(projectDir), [], { AGENT_HUD_STATE_DIR: stateDir });
    const db = new Database(join(stateDir, "shared.db"), { readonly: true });
    const rows = db.query("SELECT k FROM kv WHERE k LIKE 'cmdcache:%'").all();
    db.close();
    expect(rows).toHaveLength(0);
  });

  test(
    "the same command in two cwds keeps separate cache entries",
    async () => {
      const stateDir = tempDir("agent-hud-state-");
      const dirA = tempDir("agent-hud-a-");
      const dirB = tempDir("agent-hud-b-");
      const args = ["echo", "shared"];
      const body = `[layout]\nlines = [ ${tomlList(["cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;
      const dbPath = join(stateDir, "shared.db");
      // Sequential: this asserts key isolation across cwds, not lease racing,
      // So each render's own refresh is observed before the next one starts.
      await runWithConfig(body, dirA, stateDir);
      expect(await pollCachedOutput(dbPath, expectedKey("k8s", args, dirA))).toBe("shared");
      await runWithConfig(body, dirB, stateDir);
      expect(await pollCachedOutput(dbPath, expectedKey("k8s", args, dirB))).toBe("shared");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "the packaged build is directly executable and refreshes via its own helper",
    async () => {
      const outDir = tempDir("agent-hud-package-");
      const artifact = join(outDir, "agent-hud.ts");
      const build = Bun.spawnSync(
        [process.execPath, "build", "--target=bun", `--outfile=${artifact}`, ENTRY],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const buildErr = new TextDecoder().decode(build.stderr);
      if (build.exitCode !== 0) throw new Error(`package build failed: ${buildErr}`);
      expect(buildErr).toBe("");
      // The shebang must appear exactly once, or the interpreter parses the
      // Second one as source and direct execution dies with a syntax error.
      const text = readFileSync(artifact, "utf8");
      expect(text.split("#!/usr/bin/env bun")).toHaveLength(2);
      expect(statSync(artifact).mode & 0o111).toBeGreaterThan(0);

      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const args = ["echo", "packaged"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;
      // Executed directly — no `bun <file>` — because the detached self-reexec
      // Runs the artifact through process.execPath the same way.
      const proc = Bun.spawn([artifact], {
        stdin: Buffer.from(stdinFor(projectDir)),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          AGENT_HUD_STATE_DIR: stateDir,
          AGENT_HUD_CONFIG: writeConfig(body),
          AGENT_HUD_NO_ALIGN: "1",
        },
      });
      const result = await collectChild(proc);
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expect(Bun.stripANSI(result.out)).toBe("fable-5");
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("packaged");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "the bundled build refreshes via its own detached helper",
    async () => {
      const outDir = tempDir("agent-hud-bundle-");
      const built = await Bun.build({
        entrypoints: [ENTRY],
        target: "bun",
        outdir: outDir,
      });
      expect(built.success).toBe(true);
      const artifact = join(outDir, "index.js");
      const projectDir = tempDir("agent-hud-proj-");
      const stateDir = tempDir("agent-hud-state-");
      const args = ["echo", "bundled"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;
      const result = await runStatusline(
        stdinFor(projectDir),
        [],
        { AGENT_HUD_CONFIG: writeConfig(body), AGENT_HUD_STATE_DIR: stateDir },
        artifact,
      );
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expect(Bun.stripANSI(result.out)).toBe("fable-5");
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("bundled");
    },
    POLL_TEST_TIMEOUT_MS,
  );
});
