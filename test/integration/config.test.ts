import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  parseConfig,
  referencedCommandIds,
  resolveConfigPath,
} from "../../src/config.ts";
import { DEFAULT_CMD_TIMEOUT_MS, DEFAULT_CMD_TTL_SECS } from "../../src/constants.ts";

const tempRoots = new Set<string>();

const tempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "agent-hud-config-"));
  tempRoots.add(path);
  return path;
};

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("parseConfig", () => {
  test("parses a multi-line layout", () => {
    expect(
      parseConfig(`
[layout]
lines = [
  ["vcs", "model", "context"],
  ["rate-limits", "clock"],
]
`).layout,
    ).toEqual([
      ["vcs", "model", "context"],
      ["rate-limits", "clock"],
    ]);
  });

  test("layout-only config has no commands", () => {
    expect(parseConfig(LAYOUT_ONLY).commands.size).toBe(0);
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

const LAYOUT_ONLY = '[layout]\nlines = [ ["clock"] ]\n';

const withCommand = (body: string, line = '["cmd:k8s"]'): string =>
  `[layout]\nlines = [ ${line} ]\n\n[commands.k8s]\n${body}\n`;

describe("parseConfig commands", () => {
  test("parses argv with defaults applied", () => {
    const config = parseConfig(withCommand('argv = ["kubectl", "config"]'));
    expect(config.layout).toEqual([["cmd:k8s"]]);
    expect(config.commands.get("k8s")).toEqual({
      id: "k8s",
      argv: ["kubectl", "config"],
      timeoutMs: DEFAULT_CMD_TIMEOUT_MS,
      ttlSecs: DEFAULT_CMD_TTL_SECS,
    });
  });

  test("honours explicit timeoutMs and ttlSecs", () => {
    const config = parseConfig(withCommand('argv = ["a"]\ntimeoutMs = 1500\nttlSecs = 30'));
    expect(config.commands.get("k8s")?.timeoutMs).toBe(1500);
    expect(config.commands.get("k8s")?.ttlSecs).toBe(30);
  });

  test("commands may be defined without being referenced", () => {
    const config = parseConfig(withCommand('argv = ["a"]', '["clock"]'));
    expect(config.layout).toEqual([["clock"]]);
    expect(config.commands.has("k8s")).toBe(true);
  });

  test("rejects a shell string argv", () => {
    expect(() => parseConfig(withCommand('argv = "kubectl config"'))).toThrow(
      "commands.k8s.argv must be an array of strings (shell strings are not supported)",
    );
  });

  test("rejects a missing or empty argv", () => {
    expect(() => parseConfig(withCommand("ttlSecs = 5"))).toThrow(
      "commands.k8s.argv must be a non-empty array of strings",
    );
    expect(() => parseConfig(withCommand("argv = []"))).toThrow(
      "commands.k8s.argv must be a non-empty array of strings",
    );
    expect(() => parseConfig(withCommand('argv = ["a", ""]'))).toThrow(
      "commands.k8s.argv must be a non-empty array of strings",
    );
    expect(() => parseConfig(withCommand("argv = [1]"))).toThrow(
      "commands.k8s.argv must be a non-empty array of strings",
    );
  });

  test("rejects out-of-range timeoutMs and ttlSecs", () => {
    expect(() => parseConfig(withCommand('argv = ["a"]\ntimeoutMs = 0'))).toThrow(
      "commands.k8s.timeoutMs must be an integer between 1 and 30000",
    );
    expect(() => parseConfig(withCommand('argv = ["a"]\ntimeoutMs = 30001'))).toThrow(
      "commands.k8s.timeoutMs must be an integer between 1 and 30000",
    );
    expect(() => parseConfig(withCommand('argv = ["a"]\nttlSecs = 86401'))).toThrow(
      "commands.k8s.ttlSecs must be an integer between 1 and 86400",
    );
  });

  test("rejects an invalid command id", () => {
    expect(() => parseConfig(`${LAYOUT_ONLY}\n[commands."bad id"]\nargv = [ "a" ]\n`)).toThrow(
      "Invalid command id: bad id",
    );
  });

  test("rejects a non-table commands entry", () => {
    expect(() => parseConfig(`commands = 3\n${LAYOUT_ONLY}`)).toThrow("commands must be a table");
    expect(() => parseConfig(`${LAYOUT_ONLY}\n[commands]\nk8s = 3\n`)).toThrow(
      "commands.k8s must be a table",
    );
  });

  test("rejects a dangling cmd ref", () => {
    expect(() => parseConfig('[layout]\nlines = [ ["cmd:ghost"] ]\n')).toThrow(
      "Unknown command: ghost",
    );
  });

  test("rejects an empty cmd ref id", () => {
    expect(() => parseConfig('[layout]\nlines = [ ["cmd:"] ]\n')).toThrow("Unknown section: cmd:");
  });
});

describe("referencedCommandIds", () => {
  test("dedupes while preserving layout order", () => {
    expect(
      referencedCommandIds([
        ["vcs", "cmd:b", "cmd:a"],
        ["cmd:b", "clock"],
      ]),
    ).toEqual(["b", "a"]);
  });

  test("empty for builtin-only layouts", () => {
    expect(referencedCommandIds([["clock"]])).toEqual([]);
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

describe("loadConfig", () => {
  test("loads the path selected by AGENT_HUD_CONFIG", async () => {
    const dir = tempDir();
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

    expect((await loadConfig({ AGENT_HUD_CONFIG: path }, "/unused"))?.layout).toEqual([
      ["clock", "model"],
    ]);
  });

  test("missing config is ignored", async () => {
    expect(await loadConfig({ AGENT_HUD_CONFIG: "/does/not/exist" }, "/unused")).toBeUndefined();
  });

  test("malformed config throws", async () => {
    const dir = tempDir();
    const path = join(dir, "config.toml");
    writeFileSync(path, '[layout]\nlines = [ ["weather"] ]\n');
    // Bun types the matcher as void even though it returns a promise; the
    // Wrapper adopts it so the rejection is actually awaited, not floated.
    await Promise.resolve(
      expect(loadConfig({ AGENT_HUD_CONFIG: path }, "/unused")).rejects.toThrow(
        "Unknown section: weather",
      ),
    );
  });
});
