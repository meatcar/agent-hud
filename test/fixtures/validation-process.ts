import { writeFile } from "node:fs/promises";

const mode = process.argv[2];

if (mode === "tree-parent") {
  const marker = process.argv[3] ?? "";
  const child = Bun.spawn([process.execPath, import.meta.path, "tree-child", marker], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
} else if (mode === "tree-child") {
  await Bun.sleep(400);
  await writeFile(process.argv[3] ?? "", "survived");
  await Bun.sleep(10_000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(64 * 1024));
} else {
  process.exit(2);
}
