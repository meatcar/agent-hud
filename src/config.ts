import { homedir } from "node:os";
import { join } from "node:path";

import { type SectionName, isSectionName } from "./fields.ts";

export type Layout = SectionName[][];
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseConfig = (input: string): Layout => {
  const parsed: unknown = Bun.TOML.parse(input);
  if (!isObject(parsed) || !isObject(parsed.layout) || !Array.isArray(parsed.layout.lines)) {
    throw new Error("Config must define layout.lines");
  }
  const lines = parsed.layout.lines;
  if (lines.length === 0) {
    throw new Error("layout.lines must not be empty");
  }

  return lines.map((line, index) => {
    if (!Array.isArray(line) || line.length === 0) {
      throw new Error(`layout.lines[${index}] must be a non-empty array`);
    }
    return line.map((section) => {
      if (typeof section !== "string" || !isSectionName(section)) {
        throw new Error(`Unknown section: ${String(section)}`);
      }
      return section;
    });
  });
};

export const resolveConfigPath = (env: ConfigEnv, home = homedir()): string => {
  if (env.AGENT_HUD_CONFIG) return env.AGENT_HUD_CONFIG;
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "agent-hud", "config.toml");
};

export const loadLayout = async (
  env: ConfigEnv = process.env,
  home = homedir(),
): Promise<Layout | undefined> => {
  const file = Bun.file(resolveConfigPath(env, home));
  if (!(await file.exists())) return undefined;
  return parseConfig(await file.text());
};
