import { rm, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { runProcess } from "./process.ts";

const ROOT = resolve(import.meta.dir, "..");
const COVERAGE_DIR = resolve(ROOT, "coverage");
const LCOV_PATH = resolve(COVERAGE_DIR, "lcov.info");
const JUNIT_PATH = resolve(COVERAGE_DIR, "junit.xml");
const ENTRYPOINT_TEST = "test/integration/index.test.ts";
const ENTRYPOINT_EXEMPTION = "src/index.ts";
const COVERAGE_TIMEOUT_MS = 180_000;

const ENTRYPOINT_SCENARIOS = [
  ["malformed stdin fallback", "malformed stdin still prints and exits 0"],
  ["valid default output", "valid stdin renders two lines"],
  ["TOML configuration wiring", "TOML config controls line layout"],
  ["CLI precedence wiring", "CLI sections override the TOML layout"],
  [
    "direct executable build",
    "the packaged build is directly executable and refreshes via its own helper",
  ],
  ["bundled execution", "the bundled build refreshes via its own detached helper"],
  [
    "detached helper refresh",
    "a cold render prints immediately, then a detached helper fills the cache",
  ],
] as const;

const runCoverage = async (): Promise<void> => {
  const result = await runProcess(
    [
      process.execPath,
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${COVERAGE_DIR}`,
      "--reporter=junit",
      `--reporter-outfile=${JUNIT_PATH}`,
    ],
    { cwd: ROOT, timeoutMs: COVERAGE_TIMEOUT_MS },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`coverage test run exited ${result.code}`);
};

interface SourceManifest {
  runtime: string[];
  typeOnly: string[];
}

const sourceManifest = async (): Promise<SourceManifest> => {
  const runtime: string[] = [];
  const typeOnly: string[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const glob = new Bun.Glob("src/**/*.ts");
  for await (const path of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    const output = transpiler.transformSync(await readFile(resolve(ROOT, path), "utf8")).trim();
    (output === "" ? typeOnly : runtime).push(path);
  }
  return { runtime: runtime.toSorted(), typeOnly: typeOnly.toSorted() };
};

const coveredFiles = async (): Promise<Set<string>> => {
  const lcov = await readFile(LCOV_PATH, "utf8");
  return new Set(
    lcov
      .split("\n")
      .filter((line) => line.startsWith("SF:"))
      .map((line) => {
        const path = line.slice(3);
        return path.startsWith("/") ? relative(ROOT, path) : path;
      }),
  );
};

interface JunitCase {
  name: string;
  file: string;
  body: string;
}

const decodeXml = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const attributes = (source: string): Map<string, string> => {
  const parsed = new Map<string, string>();
  for (const match of source.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) parsed.set(name, decodeXml(value));
  }
  return parsed;
};

const junitCases = async (): Promise<JunitCase[]> => {
  const xml = await readFile(JUNIT_PATH, "utf8");
  const cases: JunitCase[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const fields = attributes(match[1] ?? "");
    const name = fields.get("name");
    const file = fields.get("file");
    if (name !== undefined && file !== undefined) {
      cases.push({ name, file, body: match[2] ?? "" });
    }
  }
  return cases;
};

const validateEntrypointChecklist = async (): Promise<void> => {
  const cases = await junitCases();
  const failures: string[] = [];
  console.log(`entrypoint coverage exemption: ${ENTRYPOINT_EXEMPTION} (subprocess-only)`);
  for (const [scenario, testName] of ENTRYPOINT_SCENARIOS) {
    const matches = cases.filter(
      (testCase) => testCase.file === ENTRYPOINT_TEST && testCase.name === testName,
    );
    const passed =
      matches.length === 1 && !/<(?:failure|error|skipped)\b/.test(matches[0]?.body ?? "");
    console.log(`  ${passed ? "✓" : "✗"} ${scenario}: ${testName}`);
    if (!passed) failures.push(`${scenario} (${matches.length} JUnit matches)`);
  }
  if (failures.length > 0) {
    throw new Error(`entrypoint scenarios did not execute and pass: ${failures.join(", ")}`);
  }
};

try {
  await rm(COVERAGE_DIR, { recursive: true, force: true });
  await runCoverage();
  const manifest = await sourceManifest();
  const covered = await coveredFiles();
  const required = manifest.runtime.filter((path) => path !== ENTRYPOINT_EXEMPTION);
  const missing = required.filter((path) => !covered.has(path));

  console.log(
    `runtime coverage manifest: ${required.length - missing.length}/${required.length} instrumented modules`,
  );
  for (const path of manifest.typeOnly) console.log(`  type-only: ${path} — emits no JavaScript`);
  console.log(
    `  exempt: ${ENTRYPOINT_EXEMPTION} — exercised only through captured subprocess contracts`,
  );
  if (missing.length > 0)
    throw new Error(`runtime modules absent from LCOV: ${missing.join(", ")}`);
  await validateEntrypointChecklist();
} finally {
  await rm(COVERAGE_DIR, { recursive: true, force: true });
}
