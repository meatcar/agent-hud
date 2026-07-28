import { homedir } from "node:os";
import { join } from "node:path";

import { type CustomCommands, parseCommandsTable } from "./commands.ts";
import { type LayoutItem, customRefId, isCustomRef, isSectionName } from "./fields.ts";

export type Layout = LayoutItem[][];
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

export interface AgentHudConfig {
  layout: Layout;
  commands: CustomCommands;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const referencedCommandIds = (layout: Layout): string[] => {
  const ids: string[] = [];
  for (const line of layout) {
    for (const item of line) {
      if (isCustomRef(item)) {
        const id = customRefId(item);
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
};

export const parseConfig = (input: string): AgentHudConfig => {
  const parsed: unknown = Bun.TOML.parse(input);
  if (!isObject(parsed) || !isObject(parsed.layout) || !Array.isArray(parsed.layout.lines)) {
    throw new Error("Config must define layout.lines");
  }
  const lines = parsed.layout.lines;
  if (lines.length === 0) {
    throw new Error("layout.lines must not be empty");
  }
  const commands = parseCommandsTable(parsed.commands);

  const layout: Layout = lines.map((line, index) => {
    if (!Array.isArray(line) || line.length === 0) {
      throw new Error(`layout.lines[${index}] must be a non-empty array`);
    }
    return line.map((item: unknown): LayoutItem => {
      if (typeof item === "string" && isCustomRef(item)) {
        const id = customRefId(item);
        if (!commands.has(id)) {
          throw new Error(`Unknown command: ${id}`);
        }
        return item;
      }
      if (typeof item !== "string" || !isSectionName(item)) {
        throw new Error(`Unknown section: ${String(item)}`);
      }
      return item;
    });
  });
  return { layout, commands };
};

export const resolveConfigPath = (env: ConfigEnv, home = homedir()): string => {
  if (env.AGENT_HUD_CONFIG) return env.AGENT_HUD_CONFIG;
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "agent-hud", "config.toml");
};

export const loadConfig = async (
  env: ConfigEnv = process.env,
  home = homedir(),
): Promise<AgentHudConfig | undefined> => {
  const file = Bun.file(resolveConfigPath(env, home));
  if (!(await file.exists())) return undefined;
  return parseConfig(await file.text());
};
