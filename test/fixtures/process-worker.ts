#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";

import { claimLease } from "../../src/commands.ts";
import { maybeGc } from "../../src/gc.ts";
import { mergeWithSharedDbLongBudget, openDb } from "../../src/rate-limits.ts";

const args = process.argv.slice(2);
const readyPath = args.at(-2) ?? "";
const goPath = args.at(-1) ?? "";
const modeArgs = args.slice(0, -2);

const waitForGo = async (deadline: number): Promise<void> => {
  if (existsSync(goPath)) return;
  if (Date.now() >= deadline) throw new Error("barrier timeout");
  await Bun.sleep(10);
  return waitForGo(deadline);
};

const optionalNumber = (value: string | undefined): number | undefined =>
  value === undefined || value === "" ? undefined : Number(value);

const [mode, ...values] = modeArgs;
writeFileSync(readyPath, "ready\n");
await waitForGo(Date.now() + 30_000);

if (mode === "merge") {
  const [dbPath, nowRaw, fivePctRaw, fiveResetRaw, sevenPctRaw, sevenResetRaw] = values;
  const fivePct = optionalNumber(fivePctRaw);
  const fiveReset = optionalNumber(fiveResetRaw);
  const sevenPct = optionalNumber(sevenPctRaw);
  const sevenReset = optionalNumber(sevenResetRaw);
  const result = mergeWithSharedDbLongBudget(dbPath ?? "", {
    stdin: {
      fiveHour:
        fivePct === undefined || fiveReset === undefined
          ? undefined
          : { pct: fivePct, resetsAt: fiveReset },
      sevenDay:
        sevenPct === undefined || sevenReset === undefined
          ? undefined
          : { pct: sevenPct, resetsAt: sevenReset },
    },
    session: undefined,
    now: Number(nowRaw),
  });
  process.stdout.write(`${JSON.stringify(result.rateLimits)}\n`);
} else if (mode === "gc") {
  const [dbPath, stateDir, nowRaw] = values;
  process.stdout.write(`${await maybeGc(dbPath ?? "", stateDir ?? "", Number(nowRaw))}\n`);
} else if (mode === "lease") {
  const [dbPath, key, nowRaw, leaseRaw, token] = values;
  const db = openDb(dbPath ?? "");
  try {
    process.stdout.write(
      `${claimLease(db, key ?? "", Number(nowRaw), Number(leaseRaw), token ?? "")}\n`,
    );
  } finally {
    db.close();
  }
} else {
  throw new Error(`unknown worker mode: ${mode ?? ""}`);
}
