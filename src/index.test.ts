import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheKey } from "./commands.ts";
import { DEFAULT_CMD_TIMEOUT_MS, DEFAULT_CMD_TTL_SECS } from "./constants.ts";
import { FIXTURE_PATH, pollCachedOutput } from "./test-support.ts";

const ENTRY = new URL("index.ts", import.meta.url).pathname;

const runStatusline = async (
  stdin: string,
  sections: string[] = [],
  env: Record<string, string> = {},
  entry = ENTRY,
): Promise<{ code: number; out: string; err: string }> => {
  const testDir = mkdtempSync(join(tmpdir(), "agent-hud-idx-"));
  const proc = Bun.spawn(["bun", entry, ...sections], {
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
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err };
};

// Detached helpers are polled with a hard deadline; the per-test budget must
// Exceed that deadline so a slow machine reports a real failure, not a timeout.
const POLL_TEST_TIMEOUT_MS = 30_000;

const stdinFor = (projectDir: string): string =>
  JSON.stringify({
    workspace: { project_dir: projectDir },
    model: { id: "claude-fable-5" },
  });

const tomlList = (items: string[]): string => `[ ${items.map((i) => `"${i}"`).join(", ")} ]`;

const tomlArgv = (args: string[]): string => tomlList(args);

const writeConfig = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "agent-hud-config-")), "config.toml");
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
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
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

  test("section arguments render only those sections in order", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const { code, out } = await runStatusline(
      JSON.stringify({
        workspace: { project_dir: projectDir },
        model: { id: "claude-fable-5" },
      }),
      ["vcs", "model"],
    );
    const plain = Bun.stripANSI(out);
    expect(code).toBe(0);
    expect(plain).toStartWith(`${projectDir.split("/").at(-1)} fable-5`);
    expect(plain).not.toContain("\n");
  });

  test("TOML config controls line layout", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const configPath = join(mkdtempSync(join(tmpdir(), "agent-hud-config-")), "config.toml");
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
    expect(lines[0]).toBe(`${projectDir.split("/").at(-1)} fable-5`);
    expect(lines[1]).toStartWith("50%");
  });

  test("CLI sections override the TOML layout", async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), "agent-hud-config-")), "config.toml");
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
      const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
      const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
      const args = ["echo", "prod-cluster"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;

      const started = Date.now();
      const first = await runWithConfig(body, projectDir, stateDir);
      const elapsed = Date.now() - started;
      expect(first.code).toBe(0);
      // Stale/empty renders immediately: the parent never waits on the command.
      expect(Bun.stripANSI(first.out)).toBe("fable-5");
      expect(elapsed).toBeLessThan(5000);

      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("prod-cluster");

      const second = await runWithConfig(body, projectDir, stateDir);
      expect(Bun.stripANSI(second.out)).toBe("fable-5 prod-cluster");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("a slow command never blocks the render", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
    const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:slow"])} ]\n\n${customCmd("slow", ["sleep", "10000"])}`;
    const started = Date.now();
    const { code, out } = await runWithConfig(body, projectDir, stateDir);
    expect(code).toBe(0);
    expect(Bun.stripANSI(out)).toBe("fable-5");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test(
    "concurrent renders run the command exactly once",
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
      const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
      const marker = join(stateDir, "ran.txt");
      const args = ["count", marker, "once"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;

      await Promise.all([
        runWithConfig(body, projectDir, stateDir),
        runWithConfig(body, projectDir, stateDir),
        runWithConfig(body, projectDir, stateDir),
      ]);
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("once");
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("a failing command renders empty and does not respawn every render", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
    const marker = join(stateDir, "ran.txt");
    const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:bad"])} ]\n\n[commands.bad]\nargv = ${tomlArgv([process.execPath, FIXTURE_PATH, "count", marker, "x"])}\nttlSecs = 3600\n`;

    const first = await runWithConfig(body, projectDir, stateDir);
    expect(Bun.stripANSI(first.out)).toBe("fable-5");
    await pollCachedOutput(join(stateDir, "shared.db"), "never", 500);
    const second = await runWithConfig(body, projectDir, stateDir);
    expect(second.code).toBe(0);
    // The first render's lease is still live, so the second never re-spawns.
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("an unreferenced command never executes", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
    const marker = join(stateDir, "ran.txt");
    const body = `[layout]\nlines = [ ${tomlList(["model"])} ]\n\n${customCmd("unused", ["count", marker, "x"])}`;
    const { code, out } = await runWithConfig(body, projectDir, stateDir);
    expect(code).toBe(0);
    expect(Bun.stripANSI(out)).toBe("fable-5");
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
  });

  test("a render with no commands writes no cmdcache rows", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
    const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
    await runStatusline(stdinFor(projectDir), [], { AGENT_HUD_STATE_DIR: stateDir });
    const db = new Database(join(stateDir, "shared.db"), { readonly: true });
    const rows = db.query("SELECT k FROM kv WHERE k LIKE 'cmdcache:%'").all();
    db.close();
    expect(rows).toHaveLength(0);
  });

  test(
    "the same command in two cwds keeps separate cache entries",
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
      const dirA = mkdtempSync(join(tmpdir(), "agent-hud-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "agent-hud-b-"));
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
      const repoRoot = new URL("..", import.meta.url).pathname;
      const build = Bun.spawnSync(["bun", "run", "build"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(build.exitCode).toBe(0);
      const artifact = join(repoRoot, "dist", "agent-hud.ts");
      // The shebang must appear exactly once, or the interpreter parses the
      // Second one as source and direct execution dies with a syntax error.
      const text = readFileSync(artifact, "utf8");
      expect(text.split("#!/usr/bin/env bun")).toHaveLength(2);
      expect(statSync(artifact).mode & 0o111).toBeGreaterThan(0);

      const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
      const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
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
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(Bun.stripANSI(out)).toBe("fable-5");
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("packaged");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "the bundled build refreshes via its own detached helper",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "agent-hud-bundle-"));
      const built = await Bun.build({
        entrypoints: [ENTRY],
        target: "bun",
        outdir: outDir,
      });
      expect(built.success).toBe(true);
      const artifact = join(outDir, "index.js");
      const projectDir = mkdtempSync(join(tmpdir(), "agent-hud-proj-"));
      const stateDir = mkdtempSync(join(tmpdir(), "agent-hud-state-"));
      const args = ["echo", "bundled"];
      const body = `[layout]\nlines = [ ${tomlList(["model", "cmd:k8s"])} ]\n\n${customCmd("k8s", args)}`;
      const { code } = await runStatusline(
        stdinFor(projectDir),
        [],
        { AGENT_HUD_CONFIG: writeConfig(body), AGENT_HUD_STATE_DIR: stateDir },
        artifact,
      );
      expect(code).toBe(0);
      const key = expectedKey("k8s", args, projectDir);
      expect(await pollCachedOutput(join(stateDir, "shared.db"), key)).toBe("bundled");
    },
    POLL_TEST_TIMEOUT_MS,
  );
});
