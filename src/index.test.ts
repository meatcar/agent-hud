import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = new URL("index.ts", import.meta.url).pathname;

const runStatusline = async (stdin: string): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bun", ENTRY], {
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      AGENT_HUD_STATE_DIR: mkdtempSync(join(tmpdir(), "agent-hud-idx-")),
      AGENT_HUD_NO_ALIGN: "1",
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
});
