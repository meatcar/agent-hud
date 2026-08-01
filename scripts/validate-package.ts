import { Database } from "bun:sqlite";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { type ProcessResult, runProcess } from "./process.ts";

const ROOT = resolve(import.meta.dir, "..");
const STATIC_FIXTURE = resolve(ROOT, "test/fixtures/protocols/claude-code/minimal.json");
const PROCESS_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;
const TAR_BLOCK_BYTES = 512;
const MAX_TARBALL_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const UNREACHABLE_REGISTRY = "http://127.0.0.1:1";
const INSTALL_LIFECYCLES = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
  "prepack",
  "postpack",
] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
] as const;

type EntryKind = "directory" | "file";

interface TarEntry {
  path: string;
  kind: EntryKind;
  size: number;
}

export interface PackageIdentity {
  name: string;
  version: string;
}

const checkedRun = async (
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<ProcessResult> => {
  const result = await runProcess(argv, { ...opts, timeoutMs: PROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} exited ${result.code}: ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

const packageIdentity = (manifest: unknown, source: string): PackageIdentity => {
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(`${source} must declare string name and version`);
  }
  return { name: manifest.name, version: manifest.version };
};

const runtimeFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  const glob = new Bun.Glob("src/**/*.ts");
  for await (const path of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    files.push(`package/${path}`);
  }
  return files.toSorted();
};

const expectedFiles = async (): Promise<string[]> =>
  [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    ...(await runtimeFiles()),
  ].toSorted();

const parentDirectories = (files: readonly string[]): string[] => {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].toSorted();
};

const decodeField = (header: Uint8Array, start: number, length: number): string => {
  const end = header.subarray(start, start + length).indexOf(0);
  const bytes = header.subarray(start, end === -1 ? start + length : start + end);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const parseOctal = (header: Uint8Array, start: number, length: number, label: string): number => {
  const raw = decodeField(header, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}: ${JSON.stringify(raw)}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
};

const validateChecksum = (header: Uint8Array): void => {
  const expected = parseOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected)
    throw new Error(`tar header checksum mismatch: ${actual} != ${expected}`);
};

const safeArchivePath = (rawPath: string, kind: EntryKind): string => {
  const path = kind === "directory" ? rawPath.replace(/\/+$/, "") : rawPath;
  if (path === "" || path.startsWith("/") || isAbsolute(path)) {
    throw new Error(`unsafe absolute or empty tar path: ${JSON.stringify(rawPath)}`);
  }
  const components = path.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`unsafe tar path component: ${JSON.stringify(rawPath)}`);
  }
  return path;
};

export const inspectTarArchive = (archive: Uint8Array): TarEntry[] => {
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      const secondOffset = offset + TAR_BLOCK_BYTES;
      const second = archive.subarray(secondOffset, secondOffset + TAR_BLOCK_BYTES);
      if (second.length !== TAR_BLOCK_BYTES || !second.every((byte) => byte === 0)) {
        throw new Error("tar archive requires two zero terminator blocks");
      }
      terminated = true;
      if (!archive.subarray(secondOffset + TAR_BLOCK_BYTES).every((byte) => byte === 0)) {
        throw new Error("tar archive has non-zero data after its terminator");
      }
      break;
    }
    validateChecksum(header);
    if (decodeField(header, 257, 6) !== "ustar") throw new Error("unsupported tar header format");
    const name = decodeField(header, 0, 100);
    const prefix = decodeField(header, 345, 155);
    const rawPath = prefix === "" ? name : `${prefix}/${name}`;
    const type = header[156] ?? 0;
    const kind: EntryKind =
      type === 0 || type === 0x30
        ? "file"
        : type === 0x35
          ? "directory"
          : (() => {
              throw new Error(
                `unsupported tar entry type ${String.fromCharCode(type)} at ${rawPath}`,
              );
            })();
    const path = safeArchivePath(rawPath, kind);
    if (paths.has(path)) throw new Error(`duplicate tar path: ${path}`);
    paths.add(path);
    const size = parseOctal(header, 124, 12, "size");
    if (kind === "directory" && size !== 0) throw new Error(`tar directory has data: ${path}`);
    entries.push({ path, kind, size });
    offset += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset > archive.length) throw new Error(`truncated tar entry: ${path}`);
  }
  if (!terminated) throw new Error("tar archive has no zero-block terminator");
  return entries;
};

export const readArchive = async (tarball: string): Promise<Uint8Array> => {
  const compressedSize = (await stat(tarball)).size;
  if (compressedSize > MAX_TARBALL_BYTES)
    throw new Error(`tarball exceeds ${MAX_TARBALL_BYTES} bytes`);
  const compressed = await readFile(tarball);
  try {
    return gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (error) {
    throw new Error(`invalid or oversized gzip tarball: ${String(error)}`, { cause: error });
  }
};

const typedEntries = (entries: readonly TarEntry[]): string[] =>
  entries.map((entry) => `${entry.kind}:${entry.path}`).toSorted();

const validateTarHeaders = async (tarball: string): Promise<string[]> => {
  const files = await expectedFiles();
  const expected = files.map((path) => `file:${path}`).toSorted();
  const actual = typedEntries(inspectTarArchive(await readArchive(tarball)));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const extra = actual.filter((entry) => !expectedSet.has(entry));
    const missing = expected.filter((entry) => !actualSet.has(entry));
    throw new Error(
      `tar header allowlist mismatch; extra=[${extra.join(", ")}], missing=[${missing.join(", ")}]`,
    );
  }
  console.log(`package header allowlist: ${actual.length} regular files, 0 directory headers`);
  return files;
};

export const isContainedPath = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

export const inspectExtractedTree = async (root: string): Promise<string[]> => {
  const realRoot = await realpath(root);
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const inspected = await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`extracted symlink rejected: ${path}`);
        const resolved = await realpath(path);
        if (!isContainedPath(realRoot, resolved)) {
          throw new Error(`extracted path escapes root: ${path}`);
        }
        const relativePath = relative(realRoot, path).split(sep).join("/");
        if (info.isDirectory()) {
          return [`directory:${relativePath}`].concat(await walk(path));
        }
        if (info.isFile()) return [`file:${relativePath}`];
        throw new Error(`extracted non-regular object rejected: ${path}`);
      }),
    );
    return inspected.flat();
  };
  return (await walk(realRoot)).toSorted();
};

const validateExtractedAllowlist = async (
  extractRoot: string,
  files: readonly string[],
): Promise<void> => {
  const expected = [
    ...files.map((path) => `file:${path}`),
    ...parentDirectories(files).map((path) => `directory:${path}`),
  ].toSorted();
  const actual = await inspectExtractedTree(extractRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("extracted directory and file allowlist mismatch");
  }
};

export const validateManifest = (manifest: unknown, workspace: PackageIdentity): string => {
  const packed = packageIdentity(manifest, "packed package.json");
  if (packed.name !== workspace.name || packed.version !== workspace.version) {
    throw new Error(
      `packed identity ${packed.name}@${packed.version} does not match workspace ${workspace.name}@${workspace.version}`,
    );
  }
  if (!isRecord(manifest)) throw new Error("packed package.json must be an object");
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value !== undefined && (!isRecord(value) || Object.keys(value).length > 0)) {
      throw new Error(`published package must not declare ${field}`);
    }
  }
  for (const field of ["bundleDependencies", "bundledDependencies"] as const) {
    const bundled = manifest[field];
    if (bundled !== undefined && (!Array.isArray(bundled) || bundled.length > 0)) {
      throw new Error(`published package must not declare ${field}`);
    }
  }
  const scripts = manifest.scripts;
  if (scripts !== undefined && !isRecord(scripts))
    throw new Error("package scripts must be an object");
  for (const lifecycle of INSTALL_LIFECYCLES) {
    if (isRecord(scripts) && scripts[lifecycle] !== undefined) {
      throw new Error(`published package must not declare ${lifecycle}`);
    }
  }
  const bin = isRecord(manifest.bin) ? manifest.bin["agent-hud"] : undefined;
  if (typeof bin !== "string") throw new Error("package does not declare agent-hud bin");
  return bin;
};

const createTarball = async (root: string): Promise<string> => {
  const tarball = join(root, "agent-hud.tgz");
  await checkedRun(
    [process.execPath, "pm", "pack", "--filename", tarball, "--ignore-scripts", "--quiet"],
    { cwd: ROOT },
  );
  return tarball;
};

const readCachedOutput = (dbPath: string): string | undefined => {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ v: string }, []>("SELECT v FROM kv WHERE k LIKE 'cmdcache:%' LIMIT 1")
      .get();
    if (row === null) return undefined;
    const parsed: unknown = JSON.parse(row.v);
    return isRecord(parsed) && typeof parsed.output === "string" ? parsed.output : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
};

const pollCachedOutput = async (
  dbPath: string,
  expected: string,
  deadline = Date.now() + REFRESH_TIMEOUT_MS,
): Promise<void> => {
  if (readCachedOutput(dbPath) === expected) return;
  if (Date.now() >= deadline) {
    throw new Error(`detached helper did not cache ${JSON.stringify(expected)}`);
  }
  await Bun.sleep(20);
  return pollCachedOutput(dbPath, expected, deadline);
};

const tomlArray = (items: string[]): string =>
  `[ ${items.map((item) => JSON.stringify(item)).join(", ")} ]`;

const validateArtifact = async (artifact: string, root: string): Promise<void> => {
  const mode = (await stat(artifact)).mode;
  if ((mode & 0o111) === 0) throw new Error(`${artifact} is not executable`);

  const fixture = await readFile(STATIC_FIXTURE, "utf8");
  const projectDir = join(root, `project-${basename(artifact)}`);
  const stateDir = join(root, `state-${basename(artifact)}`);
  const commandFixture = join(root, `command-${basename(artifact)}.ts`);
  const configPath = join(root, `config-${basename(artifact)}.toml`);
  await mkdir(projectDir, { recursive: true });
  await Bun.write(commandFixture, 'process.stdout.write(process.argv[2] ?? "");\n');

  const baseEnv = {
    ...process.env,
    NO_COLOR: "1",
    AGENT_HUD_NO_ALIGN: "1",
    AGENT_HUD_STATE_DIR: stateDir,
  };
  const staticResult = await checkedRun([artifact, "model"], {
    cwd: projectDir,
    env: { ...baseEnv, AGENT_HUD_CONFIG: join(root, "missing-config.toml") },
    stdin: fixture,
  });
  if (staticResult.stderr !== "" || staticResult.stdout !== "not-claude-sonnet") {
    throw new Error(
      `static artifact output mismatch: stdout=${JSON.stringify(staticResult.stdout)} stderr=${JSON.stringify(staticResult.stderr)}`,
    );
  }

  const expected = "artifact-refresh-ok";
  const argv = [process.execPath, commandFixture, expected];
  await writeFile(
    configPath,
    `[layout]\nlines = [ ${tomlArray(["model", "cmd:artifact"])} ]\n\n[commands.artifact]\nargv = ${tomlArray(argv)}\n`,
  );
  const cold = await checkedRun([artifact], {
    cwd: projectDir,
    env: { ...baseEnv, AGENT_HUD_CONFIG: configPath },
    stdin: fixture,
  });
  if (cold.stderr !== "" || cold.stdout !== "not-claude-sonnet") {
    throw new Error(`cold artifact output mismatch: ${JSON.stringify(cold)}`);
  }
  await pollCachedOutput(join(stateDir, "shared.db"), expected);
  const warm = await checkedRun([artifact], {
    cwd: projectDir,
    env: { ...baseEnv, AGENT_HUD_CONFIG: configPath },
    stdin: fixture,
  });
  if (warm.stderr !== "" || warm.stdout !== `not-claude-sonnet ${expected}`) {
    throw new Error(`warm artifact output mismatch: ${JSON.stringify(warm)}`);
  }
  console.log(`artifact smoke: ${artifact} rendered static output and detached refresh`);
};

const validateOfficialBuild = async (root: string): Promise<void> => {
  const artifact = join(root, "agent-hud.ts");
  await checkedRun(
    [process.execPath, "build", "--target=bun", `--outfile=${artifact}`, "src/index.ts"],
    { cwd: ROOT },
  );
  const source = await readFile(artifact, "utf8");
  if (source.split("#!/usr/bin/env bun").length !== 2) {
    throw new Error("official build must contain exactly one Bun shebang");
  }
  await validateArtifact(artifact, join(root, "official-build"));
};

const validateOfflineInstall = async (
  tarball: string,
  identity: PackageIdentity,
  root: string,
): Promise<void> => {
  const installRoot = join(root, "offline-install");
  const cacheRoot = join(root, "offline-cache");
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { [identity.name]: `file:${tarball}` } }, null, 2)}\n`,
  );
  await checkedRun(
    [
      process.execPath,
      "install",
      `--registry=${UNREACHABLE_REGISTRY}`,
      `--cache-dir=${cacheRoot}`,
      "--ignore-scripts",
      "--no-progress",
      "--no-summary",
    ],
    {
      cwd: installRoot,
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        npm_config_registry: UNREACHABLE_REGISTRY,
      },
    },
  );
  const nodeModules = join(installRoot, "node_modules");
  const artifact = join(nodeModules, ".bin", "agent-hud");
  const target = await realpath(artifact);
  const realModules = await realpath(nodeModules);
  if (!isContainedPath(realModules, target))
    throw new Error("installed bin target escapes node_modules");
  await validateArtifact(artifact, join(root, "installed-bin"));
  console.log(`offline install: ${identity.name}@${identity.version} used no reachable registry`);
};

const validateTarball = async (tarball: string, root: string): Promise<void> => {
  const workspaceManifest = await parseJson(join(ROOT, "package.json"));
  const workspace = packageIdentity(workspaceManifest, "workspace package.json");
  const files = await validateTarHeaders(tarball);
  const extractRoot = join(root, "extract");
  await mkdir(extractRoot, { recursive: false });
  await checkedRun(["tar", "-xzf", tarball, "-C", extractRoot]);
  await validateExtractedAllowlist(extractRoot, files);
  const packageRoot = join(extractRoot, "package");
  const realExtractRoot = await realpath(extractRoot);
  const realPackageRoot = await realpath(packageRoot);
  if (!isContainedPath(realExtractRoot, realPackageRoot))
    throw new Error("package root escapes extraction");
  const manifest = await parseJson(join(realPackageRoot, "package.json"));
  const declaredBin = validateManifest(manifest, workspace);
  const artifact = resolve(realPackageRoot, declaredBin);
  const relativeBin = relative(realPackageRoot, artifact);
  if (relativeBin === ".." || relativeBin.startsWith(`..${sep}`) || isAbsolute(relativeBin)) {
    throw new Error("declared bin escapes package");
  }
  const artifactInfo = await lstat(artifact);
  if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink()) {
    throw new Error("declared bin is not an extracted regular file");
  }
  const realArtifact = await realpath(artifact);
  if (!isContainedPath(realPackageRoot, realArtifact))
    throw new Error("declared bin escapes package");
  console.log(
    `package identity: ${workspace.name}@${workspace.version}; ${(await stat(tarball)).size} compressed bytes`,
  );
  await validateArtifact(realArtifact, join(root, "extracted-bin"));
  await validateOfflineInstall(tarball, workspace, root);
};

const main = async (): Promise<void> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-hud-package-"));
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--bin") {
      if (args.length !== 2) throw new Error("usage: validate-package.ts --bin <executable>");
      await validateArtifact(resolve(args[1] ?? ""), join(tempRoot, "external-bin"));
    } else {
      if (args.length > 1) throw new Error("usage: validate-package.ts [tarball]");
      const tarball = args[0] === undefined ? await createTarball(tempRoot) : resolve(args[0]);
      await validateTarball(tarball, tempRoot);
      await validateOfficialBuild(tempRoot);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
