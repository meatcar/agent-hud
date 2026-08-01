import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  inspectExtractedTree,
  inspectTarArchive,
  isContainedPath,
  readArchive,
  validateManifest,
} from "../../scripts/validate-package.ts";

const BLOCK = 512;
const IDENTITY = { name: "@meatcar/agent-hud", version: "0.2.0" };
const MANIFEST = { ...IDENTITY, bin: { "agent-hud": "src/index.ts" } };

interface HeaderOptions {
  magic?: string;
  rawSize?: string;
  size?: number;
}

const writeText = (target: Uint8Array, offset: number, length: number, value: string): void => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error("test tar field is too long");
  target.set(bytes, offset);
};

const writeOctal = (target: Uint8Array, offset: number, length: number, value: number): void => {
  writeText(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
};

const finalizeChecksum = (block: Uint8Array): void => {
  block.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeText(block, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
};

const header = (path: string, type = "0", options: HeaderOptions = {}): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, 100, path);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (options.rawSize === undefined) {
    writeOctal(block, 124, 12, options.size ?? 0);
  } else {
    writeText(block, 124, 12, `${options.rawSize}\0`);
  }
  writeOctal(block, 136, 12, 0);
  writeText(block, 156, 1, type);
  writeText(block, 257, 6, options.magic ?? "ustar\0");
  writeText(block, 263, 2, "00");
  finalizeChecksum(block);
  return block;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const terminators = (count = 2): Uint8Array => new Uint8Array(count * BLOCK);

const archive = (...headers: Uint8Array[]): Uint8Array => concat(...headers, terminators());

const archiveWithData = (block: Uint8Array, data: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  return concat(block, padded, terminators());
};

const failureMessage = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  throw new Error("expected operation to fail");
};

describe("tar archive inspection", () => {
  test("accepts regular files and directories with two terminator blocks", () => {
    expect(
      inspectTarArchive(archive(header("package/file.ts"), header("package/empty/", "5"))),
    ).toEqual([
      { path: "package/file.ts", kind: "file", size: 0 },
      { path: "package/empty", kind: "directory", size: 0 },
    ]);
  });

  test.each(["/absolute", "./dot", "package/../escape", "package//empty"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => inspectTarArchive(archive(header(path)))).toThrow("unsafe");
    },
  );

  test("rejects duplicate normalized paths", () => {
    expect(() =>
      inspectTarArchive(archive(header("package/path"), header("package/path"))),
    ).toThrow("duplicate tar path");
  });

  test.each(["1", "2", "3", "4", "6"])("rejects tar entry type %s", (type) => {
    expect(() => inspectTarArchive(archive(header("package/object", type)))).toThrow(
      "unsupported tar entry type",
    );
  });

  test("rejects a corrupted checksum", () => {
    const block = header("package/file");
    block[0] = (block[0] ?? 0) ^ 1;
    expect(() => inspectTarArchive(archive(block))).toThrow("checksum mismatch");
  });

  test("rejects truncated entry data", () => {
    expect(() => inspectTarArchive(header("package/file", "0", { size: 1 }))).toThrow(
      "truncated tar entry",
    );
  });

  test("rejects non-zero data after two terminators", () => {
    const trailing = terminators(3);
    trailing[trailing.length - 1] = 1;
    expect(() => inspectTarArchive(concat(header("package/file"), trailing))).toThrow(
      "non-zero data after its terminator",
    );
  });

  test("rejects a data-bearing directory", () => {
    const block = header("package/directory/", "5", { size: 1 });
    expect(() => inspectTarArchive(archiveWithData(block, new Uint8Array([1])))).toThrow(
      "directory has data",
    );
  });

  test("rejects bad USTAR magic and octal fields", () => {
    expect(() =>
      inspectTarArchive(archive(header("package/file", "0", { magic: "broken" }))),
    ).toThrow("header format");
    expect(() =>
      inspectTarArchive(archive(header("package/file", "0", { rawSize: "88888888888" }))),
    ).toThrow("invalid tar size");
  });

  test("requires two zero terminator blocks", () => {
    expect(() => inspectTarArchive(concat(header("package/file"), terminators(1)))).toThrow(
      "two zero terminator blocks",
    );
  });
});

describe("compressed archive bounds", () => {
  test("rejects compressed and expanded archives over their limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hud-archive-limit-"));
    try {
      const compressed = join(root, "compressed.tgz");
      await writeFile(compressed, new Uint8Array(2 * 1024 * 1024 + 1));
      expect(await failureMessage(readArchive(compressed))).toContain("tarball exceeds");

      const expanded = join(root, "expanded.tgz");
      await writeFile(expanded, gzipSync(new Uint8Array(16 * 1024 * 1024 + 1)));
      expect(await failureMessage(readArchive(expanded))).toContain("oversized gzip tarball");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("published manifest", () => {
  test("accepts the dependency-free manifest", () => {
    expect(validateManifest(MANIFEST, IDENTITY)).toBe("src/index.ts");
  });

  test.each(["bundleDependencies", "bundledDependencies"] as const)(
    "validates %s independently",
    (field) => {
      expect(() => validateManifest({ ...MANIFEST, [field]: ["dependency"] }, IDENTITY)).toThrow(
        field,
      );
    },
  );

  test("rejects conflicting bundle dependency aliases", () => {
    expect(() =>
      validateManifest(
        { ...MANIFEST, bundleDependencies: [], bundledDependencies: ["dependency"] },
        IDENTITY,
      ),
    ).toThrow("bundledDependencies");
  });

  test.each([
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
  ])("rejects lifecycle hook %s", (hook) => {
    expect(() => validateManifest({ ...MANIFEST, scripts: { [hook]: "run" } }, IDENTITY)).toThrow(
      hook,
    );
  });
});

describe("path containment", () => {
  test("distinguishes traversal from safe dot-prefixed names", () => {
    expect(isContainedPath("/tmp/package", "/tmp/package/src/index.ts")).toBe(true);
    expect(isContainedPath("/tmp/package", "/tmp/package/..agent-hud")).toBe(true);
    expect(isContainedPath("/tmp/package", "/tmp/other")).toBe(false);
  });

  test("recursively accepts regular objects and rejects extracted symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hud-extract-test-"));
    try {
      await mkdir(join(root, "package"));
      await writeFile(join(root, "package", "file"), "safe");
      expect(await inspectExtractedTree(root)).toEqual(["directory:package", "file:package/file"]);
      await symlink(join(root, "package", "file"), join(root, "package", "link"));
      expect(await failureMessage(inspectExtractedTree(root))).toContain(
        "extracted symlink rejected",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
