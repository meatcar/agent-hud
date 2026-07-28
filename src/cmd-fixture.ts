#!/usr/bin/env bun
// Test-only fixture driven entirely by argv, so command tests depend on
// Process.execPath alone — never on a shell or on coreutils being installed.
import { appendFileSync } from "node:fs";

const [mode, a, b] = process.argv.slice(2);

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
} else if (mode === "count") {
  appendFileSync(a ?? "", "ran\n");
  process.stdout.write(`${b ?? ""}\n`);
} else {
  process.exit(2);
}
