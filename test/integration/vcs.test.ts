import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findRepo,
  getDrift,
  parseAheadBehind,
  parseBookmarkLine,
  renderDrift,
  repoLabel,
  run,
} from "../../src/vcs.ts";
import { fixtureArgv } from "../support/commands.ts";

const stripAnsi = (str: string): string => Bun.stripANSI(str);
const tempRoots = new Set<string>();

const tmp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "agent-hud-vcs-"));
  tempRoots.add(path);
  return path;
};

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("findRepo", () => {
  test("finds .git dir at root", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    expect(findRepo(root)).toEqual({ root, kind: "git" });
  });

  test("prefers .jj over colocated .git", () => {
    const root = tmp();
    mkdirSync(join(root, ".jj"));
    mkdirSync(join(root, ".git"));
    expect(findRepo(root)).toEqual({ root, kind: "jj" });
  });

  test("walks up from nested dir", () => {
    const root = tmp();
    mkdirSync(join(root, ".jj"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findRepo(nested)).toEqual({ root, kind: "jj" });
  });

  test("accepts .git file (worktree)", () => {
    const root = tmp();
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere");
    expect(findRepo(root)).toEqual({ root, kind: "git" });
  });

  test("nearest repo wins over ancestor", () => {
    const outer = tmp();
    mkdirSync(join(outer, ".jj"));
    const inner = join(outer, "sub");
    mkdirSync(join(inner, ".git"), { recursive: true });
    expect(findRepo(inner)).toEqual({ root: inner, kind: "git" });
  });

  test("undefined when no repo", () => {
    expect(findRepo(tmp())).toBeUndefined();
  });
});

describe("parseBookmarkLine", () => {
  test("plain bookmark", () => {
    expect(parseBookmarkLine("main")).toBe("main");
  });

  test("strips moved marker and remote refs", () => {
    expect(parseBookmarkLine("main* main@origin")).toBe("main");
  });

  test("remote-only bookmark keeps name", () => {
    expect(parseBookmarkLine("main@origin")).toBe("main");
  });

  test("strips conflict marker", () => {
    expect(parseBookmarkLine("main??")).toBe("main");
  });

  test("empty → undefined", () => {
    expect(parseBookmarkLine("")).toBeUndefined();
    expect(parseBookmarkLine(undefined)).toBeUndefined();
  });
});

describe("parseAheadBehind", () => {
  test("parses left-right count (left=behind, right=ahead)", () => {
    expect(parseAheadBehind("3\t5")).toEqual({ behind: 3, ahead: 5 });
  });

  test("garbage → undefined", () => {
    expect(parseAheadBehind("nope")).toBeUndefined();
    expect(parseAheadBehind(undefined)).toBeUndefined();
  });
});

describe("renderDrift", () => {
  test("branch with ahead and behind", () => {
    expect(stripAnsi(renderDrift({ branch: "main", ahead: 2, behind: 1 }))).toBe("main ⇡2 ⇣1");
  });

  test("zero counts omitted", () => {
    expect(stripAnsi(renderDrift({ branch: "main", ahead: 0, behind: 0 }))).toBe("main");
  });

  test("counts without branch", () => {
    expect(stripAnsi(renderDrift({ branch: undefined, ahead: 4, behind: 0 }))).toBe("⇡4");
  });

  test("undefined drift → empty", () => {
    expect(renderDrift(undefined)).toBe("");
  });
});

describe("repoLabel", () => {
  test("repo root basename", () => {
    expect(stripAnsi(repoLabel({ root: "/x/y/proj", kind: "git" }, "/x/y/proj/sub"))).toBe("proj");
  });

  test("falls back to cwd basename when no repo", () => {
    expect(stripAnsi(repoLabel(undefined, "/x/y/somewhere"))).toBe("somewhere");
  });
});

describe("run", () => {
  test("captures stdout on success", async () => {
    expect(await run(fixtureArgv("echo", "ok"), ".")).toBe("ok");
  });

  test("missing binary → undefined", async () => {
    expect(await run(["definitely-not-a-real-binary-xyz"], ".")).toBeUndefined();
  });

  test("nonzero exit → undefined", async () => {
    expect(await run(fixtureArgv("fail"), ".")).toBeUndefined();
  });

  test("timeout kills and returns undefined", async () => {
    const started = Date.now();
    expect(await run(fixtureArgv("sleep", "5000"), ".", 100)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

const git = async (cwd: string, ...argv: string[]): Promise<void> => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    // Isolate from user config (signing hooks would hang the test).
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const proc = Bun.spawn(["git", ...argv], { cwd, env, stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${argv.join(" ")}: ${err || `exit ${code}`}`);
};

describe("getDrift git", () => {
  test("ahead of local main with branch name", async () => {
    const root = tmp();
    await git(root, "init", "-b", "main");
    await git(root, "commit", "--allow-empty", "-m", "one");
    await git(root, "checkout", "-b", "feature");
    await git(root, "commit", "--allow-empty", "-m", "two");
    const drift = await getDrift({ root, kind: "git" });
    expect(drift).toEqual({ branch: "feature", ahead: 1, behind: 0 });
  });

  test("on trunk itself → zero drift", async () => {
    const root = tmp();
    await git(root, "init", "-b", "main");
    await git(root, "commit", "--allow-empty", "-m", "one");
    const drift = await getDrift({ root, kind: "git" });
    expect(drift).toEqual({ branch: "main", ahead: 0, behind: 0 });
  });
});

describe.skipIf(Bun.which("jj") === null)("getDrift jj", () => {
  test("counts commits past trunk() with nearest bookmark", async () => {
    const root = tmp();
    const jj = async (...argv: string[]) => {
      const proc = Bun.spawn(["jj", ...argv], { cwd: root, stdout: "ignore", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`jj ${argv.join(" ")}: ${err || `exit ${code}`}`);
    };
    await jj("git", "init");
    await jj("describe", "-m", "one");
    await jj("bookmark", "create", "dev", "-r", "@");
    await jj("new", "-m", "two");
    const drift = await getDrift({ root, kind: "jj" });
    // No remotes: trunk() falls back to root(), so both described commits count.
    expect(drift?.branch).toBe("dev");
    expect(drift?.ahead).toBe(2);
    expect(drift?.behind).toBe(0);
  });
});
