#!/usr/bin/env bun
// Test-only fixture driven entirely by argv, so command tests depend on
// Process.execPath alone — never on a shell or on coreutils being installed.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const [mode, a, b, c] = process.argv.slice(2);

const waitForFile = async (path: string, deadline: number): Promise<void> => {
  if (existsSync(path)) return;
  if (Date.now() >= deadline) process.exit(4);
  await Bun.sleep(10);
  return waitForFile(path, deadline);
};

if (mode === "echo") {
  process.stdout.write(`${a ?? ""}\n`);
} else if (mode === "ansi") {
  process.stdout.write("\u001B]0;t\u0007\u001B[31mred\u001B[0m\tline\u202Ex\n");
} else if (mode === "big") {
  process.stdout.write("x".repeat(Number(a ?? 0)));
} else if (mode === "bigmb") {
  // Three-byte code points, so a byte cut that is not a multiple of three
  // Lands inside a character.
  process.stdout.write("字".repeat(Number(a ?? 0)));
} else if (mode === "sleep") {
  await Bun.sleep(Number(a ?? 0));
  process.stdout.write("late\n");
} else if (mode === "fail") {
  process.stdout.write("partial\n");
  process.exit(3);
} else if (mode === "count" || mode === "count-fail") {
  appendFileSync(a ?? "", "ran\n");
  process.stdout.write(`${b ?? ""}\n`);
  if (mode === "count-fail") process.exit(3);
} else if (mode === "gate") {
  writeFileSync(a ?? "", "started\n");
  await waitForFile(b ?? "", Date.now() + 10_000);
  process.stdout.write(`${c ?? "released"}\n`);
} else {
  process.exit(2);
}
