#!/usr/bin/env bun
// Reads hyperfine.json, prints a markdown comparison table to stdout

const MS_PER_SEC = 1000;
const SPEEDUP_DECIMALS = 2;
const COMPARE_THRESHOLD = 2;
const ARGV_SCRIPT_OFFSET = 2;

interface HyperfineResult {
  command: string;
  parameters?: Record<string, string>;
  mean: number;
  stddev: number;
}

const [jsonPath] = process.argv.slice(ARGV_SCRIPT_OFFSET);
if (!jsonPath) {
  process.stderr.write("usage: analyze.ts <path/to/hyperfine.json>\n");
  process.exit(1);
}

const { results }: { results: HyperfineResult[] } = await Bun.file(jsonPath).json();

const fmtMs = (secs: number, sd: number) =>
  `${(secs * MS_PER_SEC).toFixed(1)} ms ± ${(sd * MS_PER_SEC).toFixed(1)} ms`;

const normCmd = (result: HyperfineResult): string => {
  let out = result.command;
  for (const [key, val] of Object.entries(result.parameters ?? {})) {
    out = out.replaceAll(val, `{${key}}`);
  }
  return out;
};

const cmdLabel = (cmd: string) => (cmd.includes("bun") ? "bun" : "bash");

const hasParams = results.some(
  (result) => result.parameters && Object.keys(result.parameters).length > 0,
);

if (!hasParams) {
  // Component table: no parameter variation, one row per command
  console.log("| command | mean ± σ |");
  console.log("| ------- | -------- |");
  for (const result of results) {
    console.log(`| ${result.command} | ${fmtMs(result.mean, result.stddev)} |`);
  }
} else {
  // Fixture table: grouped by parameter, one column per command
  const commands = [...new Set(results.map(normCmd))];
  const fixtures = [...new Set(results.map((result) => result.parameters?.fixture ?? "unknown"))];
  const multi = commands.length >= COMPARE_THRESHOLD;
  const labels = commands.map(cmdLabel);

  const cols = multi ? ["fixture", ...labels, "speedup"] : ["fixture", ...labels];
  const sep = cols.map((col) => (multi && col === "speedup" ? "------:" : "-------"));

  console.log(`| ${cols.join(" | ")} |`);
  console.log(`| ${sep.join(" | ")} |`);

  for (const fixture of fixtures) {
    const cells = commands.map((cmd) => {
      const entry = results.find(
        (result) =>
          (result.parameters?.fixture ?? "unknown") === fixture && normCmd(result) === cmd,
      );
      return entry ? fmtMs(entry.mean, entry.stddev) : "-";
    });
    if (multi) {
      const base = results.find(
        (result) =>
          (result.parameters?.fixture ?? "unknown") === fixture && normCmd(result) === commands[0],
      );
      const cmp = results.find(
        (result) =>
          (result.parameters?.fixture ?? "unknown") === fixture && normCmd(result) === commands[1],
      );
      const speedup = base && cmp ? `${(base.mean / cmp.mean).toFixed(SPEEDUP_DECIMALS)}×` : "-";
      console.log(`| ${fixture} | ${cells.join(" | ")} | ${speedup} |`);
    } else {
      console.log(`| ${fixture} | ${cells.join(" | ")} |`);
    }
  }
}
