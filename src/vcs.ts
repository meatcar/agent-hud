import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import colors from "./colors.ts";

export type RepoKind = "jj" | "git";

export interface Repo {
  root: string;
  kind: RepoKind;
}

export interface Drift {
  branch: string | undefined;
  ahead: number | undefined;
  behind: number | undefined;
}

export const findRepo = (start: string): Repo | undefined => {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".jj"))) {
      return { root: dir, kind: "jj" };
    }
    if (existsSync(join(dir, ".git"))) {
      return { root: dir, kind: "git" };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

const RUN_TIMEOUT_MS = 2000;

// Missing binary, nonzero exit, or timeout all degrade to undefined:
// The statusline must render something even when VCS tooling is broken.
export const run = async (
  cmd: string[],
  cwd: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<string | undefined> => {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
};

export const parseBookmarkLine = (out: string | undefined): string | undefined => {
  const token = out?.split("\n")[0]?.split(/\s+/)[0];
  if (!token) {
    return undefined;
  }
  // "main*" = moved, "main??" = conflicted, "main@origin" = remote ref.
  const [name] = token.replace(/[*?]+$/, "").split("@");
  return name || undefined;
};

export const parseAheadBehind = (
  out: string | undefined,
): { ahead: number; behind: number } | undefined => {
  const match = out?.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return undefined;
  }
  const [, behind, ahead] = match;
  return { behind: Number(behind), ahead: Number(ahead) };
};

const JJ_ARGS = ["jj", "--ignore-working-copy", "--no-pager"];
// Exclude the auto-created empty undescribed working-copy commit, else the
// Ahead count reads 1 while sitting exactly on trunk.
const JJ_AHEAD = '(trunk()..@) ~ (@ & empty() & description(exact:""))';
const JJ_BEHIND = "@..trunk()";
const JJ_NEAREST_BOOKMARK = "heads(::@ & bookmarks())";

const jjLog = async (root: string, revset: string, template: string): Promise<string | undefined> =>
  run([...JJ_ARGS, "log", "--no-graph", "--color=never", "-r", revset, "-T", template], root);

const jjDrift = async (root: string): Promise<Drift> => {
  const [ahead, behind, bookmark] = await Promise.all([
    jjLog(root, JJ_AHEAD, '"."'),
    jjLog(root, JJ_BEHIND, '"."'),
    jjLog(root, JJ_NEAREST_BOOKMARK, 'bookmarks.join(" ") ++ "\n"'),
  ]);
  return {
    branch: parseBookmarkLine(bookmark),
    ahead: ahead?.length,
    behind: behind?.length,
  };
};

const GIT_TRUNK_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

const gitTrunk = async (root: string): Promise<string | undefined> => {
  const head = await run(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], root);
  if (head) {
    return head;
  }
  // Probe all candidates concurrently; first existing ref in priority order wins.
  const probes = await Promise.all(
    GIT_TRUNK_CANDIDATES.map(async (ref) =>
      run(["git", "rev-parse", "--verify", "--quiet", ref], root),
    ),
  );
  return GIT_TRUNK_CANDIDATES.find((__ref, idx) => probes[idx] !== undefined);
};

const gitDrift = async (root: string): Promise<Drift> => {
  const [branch, trunk] = await Promise.all([
    run(["git", "branch", "--show-current"], root),
    gitTrunk(root),
  ]);
  const counts = trunk
    ? parseAheadBehind(
        await run(["git", "rev-list", "--left-right", "--count", `${trunk}...HEAD`], root),
      )
    : undefined;
  return { branch: branch || undefined, ahead: counts?.ahead, behind: counts?.behind };
};

export const getDrift = async (repo: Repo): Promise<Drift> =>
  repo.kind === "jj" ? jjDrift(repo.root) : gitDrift(repo.root);

export const renderDrift = (drift: Drift | undefined): string => {
  if (drift === undefined) {
    return "";
  }
  const parts: string[] = [];
  if (drift.branch) {
    parts.push(colors.magenta(drift.branch));
  }
  if (drift.ahead) {
    parts.push(colors.green(`⇡${drift.ahead}`));
  }
  if (drift.behind) {
    parts.push(colors.red(`⇣${drift.behind}`));
  }
  return parts.join(" ");
};

export const repoLabel = (repo: Repo | undefined, cwd: string): string =>
  repo !== undefined ? colors.green(basename(repo.root)) : colors.dim(basename(cwd));
