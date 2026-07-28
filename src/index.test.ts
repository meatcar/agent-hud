import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = new URL("index.ts", import.meta.url).pathname;

const runStatusline = async (
  stdin: string,
  sections: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> => {
  const testDir = mkdtempSync(join(tmpdir(), "agent-hud-idx-"));
  const proc = Bun.spawn(["bun", ENTRY, ...sections], {
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      AGENT_HUD_STATE_DIR: join(testDir, "state"),
      AGENT_HUD_CONFIG: join(testDir, "missing-config.toml"),
      AGENT_HUD_NO_ALIGN: "1",
      ...env,
    },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
};

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
