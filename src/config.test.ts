import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLayout, parseConfig, resolveConfigPath } from "./config.ts";

describe("parseConfig", () => {
  test("parses a multi-line layout", () => {
    expect(
      parseConfig(`
[layout]
lines = [
  ["vcs", "model", "context"],
  ["rate-limits", "clock"],
]
`),
    ).toEqual([
      ["vcs", "model", "context"],
      ["rate-limits", "clock"],
    ]);
  });

  test("rejects unknown section names", () => {
    expect(() =>
      parseConfig(`
[layout]
lines = [
  ["model", "weather"],
]
`),
    ).toThrow("Unknown section: weather");
  });
});

describe("resolveConfigPath", () => {
  test("explicit path wins", () => {
    expect(
      resolveConfigPath(
        { AGENT_HUD_CONFIG: "/tmp/custom.toml", XDG_CONFIG_HOME: "/tmp/xdg" },
        "/home/test",
      ),
    ).toBe("/tmp/custom.toml");
  });

  test("uses XDG config home before the home fallback", () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/test")).toBe(
      "/tmp/xdg/agent-hud/config.toml",
    );
    expect(resolveConfigPath({}, "/home/test")).toBe("/home/test/.config/agent-hud/config.toml");
  });
});

describe("loadLayout", () => {
  test("loads the path selected by AGENT_HUD_CONFIG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hud-config-"));
    const path = join(dir, "nested", "config.toml");
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      path,
      `
[layout]
lines = [
  ["clock", "model"],
]
`,
    );

    expect(await loadLayout({ AGENT_HUD_CONFIG: path }, "/unused")).toEqual([["clock", "model"]]);
  });

  test("missing config is ignored", async () => {
    expect(await loadLayout({ AGENT_HUD_CONFIG: "/does/not/exist" }, "/unused")).toBeUndefined();
  });
});
