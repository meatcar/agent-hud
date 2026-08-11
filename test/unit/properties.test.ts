import { describe, expect, test } from "bun:test";

import { MAX_CMD_OUTPUT_BYTES, MAX_CMD_OUTPUT_WIDTH, SEVEN_DAY_SECS } from "../../src/constants.ts";
import { type Bucket, mergeBucket } from "../../src/rate-limits.ts";
import { sanitizeOutput } from "../../src/sanitize.ts";
import { checkProperty, type Random } from "../support/random.ts";

const NOW = 1_000_000;

const randomScalar = (random: Random): string => {
  const scalar = random.int(0x11_0000 - 0x800);
  return String.fromCodePoint(scalar >= 0xd800 ? scalar + 0x800 : scalar);
};

const sanitizeCase = (random: Random): string => {
  const fragments = [
    "a",
    " ",
    "\n",
    "\r",
    "\t",
    "\u0000",
    "\u001B",
    "\u001B[",
    "\u001B[31",
    "\u001B[31m",
    "\u001B]",
    "\u001B]0;partial",
    "\u001BPfragment",
    "\u001B\uD800",
    "\u001B\uDC00",
    "\u009B",
    "\u007F",
    "\u202E",
    "\u2066",
    "\u200D",
    "\u2028",
    "\uD800",
    "\uDC00",
    "\uD83Dx\uDE42",
    "字",
    "🙂",
    "\uFFFD",
    "é",
  ] as const;
  switch (random.int(6)) {
    case 0:
      return Array.from({ length: random.int(100) }, () => random.pick(fragments)).join("");
    case 1:
      return Array.from({ length: random.int(80) }, () => randomScalar(random)).join("");
    case 2:
      return "x".repeat(MAX_CMD_OUTPUT_BYTES + random.int(64));
    case 3:
      return "字".repeat(MAX_CMD_OUTPUT_WIDTH + random.int(32));
    case 4:
      return `${randomScalar(random)}\uD800${randomScalar(random)}\uDC00${randomScalar(random)}`;
    default:
      return `head${random.pick(fragments)}${randomScalar(random)}${random.pick(fragments)}tail`;
  }
};

const isLive = (bucket: Bucket | undefined): bucket is Bucket =>
  bucket !== undefined && bucket.resetsAt > NOW && bucket.resetsAt - NOW <= SEVEN_DAY_SECS;

const bucketOracle = (...buckets: readonly (Bucket | undefined)[]): Bucket | undefined => {
  let winner: Bucket | undefined;
  for (const bucket of buckets) {
    if (
      isLive(bucket) &&
      (winner === undefined ||
        bucket.resetsAt > winner.resetsAt ||
        (bucket.resetsAt === winner.resetsAt && bucket.pct > winner.pct))
    ) {
      winner = bucket;
    }
  }
  return winner;
};

const randomBucket = (random: Random): Bucket | undefined => {
  const pct = random.int(101);
  switch (random.int(4)) {
    case 0:
      return undefined;
    case 1:
      return { pct, resetsAt: NOW - random.int(SEVEN_DAY_SECS) };
    case 2:
      return { pct, resetsAt: NOW + 1 + random.int(SEVEN_DAY_SECS) };
    default:
      return { pct, resetsAt: NOW + SEVEN_DAY_SECS + 1 + random.int(SEVEN_DAY_SECS) };
  }
};

describe("sanitizeOutput properties", () => {
  test("seeded arbitrary text remains bounded, scalar-safe, and idempotent", () => {
    const seed = 0x51a7e;
    checkProperty(seed, 800, sanitizeCase, (raw) => {
      const out = sanitizeOutput(raw);
      expect(sanitizeOutput(out)).toBe(out);
      for (const codePoint of out) {
        const code = codePoint.codePointAt(0) ?? 0;
        expect(code < 0x20 || (code >= 0x7f && code <= 0x9f)).toBe(false);
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
      }
      expect(out).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CMD_OUTPUT_BYTES);
      expect(Bun.stringWidth(out)).toBeLessThanOrEqual(MAX_CMD_OUTPUT_WIDTH);
    });
  });
});

describe("mergeBucket properties", () => {
  test("matches an independent live-winner oracle over the full state union", () => {
    const seed = 0xb0c7e7;
    checkProperty(
      seed,
      2000,
      (random) => ({ a: randomBucket(random), b: randomBucket(random), c: randomBucket(random) }),
      ({ a, b, c }) => {
        expect(mergeBucket(a, a, NOW)).toEqual(bucketOracle(a));
        expect(mergeBucket(a, b, NOW)).toEqual(bucketOracle(a, b));
        expect(mergeBucket(b, a, NOW)).toEqual(bucketOracle(a, b));
        expect(mergeBucket(mergeBucket(a, b, NOW), c, NOW)).toEqual(bucketOracle(a, b, c));
        expect(mergeBucket(a, mergeBucket(b, c, NOW), NOW)).toEqual(bucketOracle(a, b, c));
      },
    );
  });

  test("classifies exact liveness boundaries", () => {
    const atNow = { pct: 100, resetsAt: NOW };
    const firstLive = { pct: 1, resetsAt: NOW + 1 };
    const lastLive = { pct: 2, resetsAt: NOW + SEVEN_DAY_SECS };
    const firstTooFar = { pct: 100, resetsAt: NOW + SEVEN_DAY_SECS + 1 };

    expect(mergeBucket(atNow, undefined, NOW)).toBeUndefined();
    expect(mergeBucket(firstLive, undefined, NOW)).toEqual(firstLive);
    expect(mergeBucket(lastLive, undefined, NOW)).toEqual(lastLive);
    expect(mergeBucket(firstTooFar, undefined, NOW)).toBeUndefined();
    expect(mergeBucket(firstLive, lastLive, NOW)).toEqual(lastLive);
  });
});
