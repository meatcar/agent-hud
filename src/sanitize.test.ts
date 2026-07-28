import { describe, expect, test } from "bun:test";

import { MAX_CMD_OUTPUT_BYTES, MAX_CMD_OUTPUT_WIDTH } from "./constants.ts";
import { sanitizeOutput } from "./sanitize.ts";

describe("sanitizeOutput", () => {
  test("strips CSI/SGR sequences", () => {
    expect(sanitizeOutput("\u001B[31mred\u001B[0m")).toBe("red");
    expect(sanitizeOutput("\u001B[2J\u001B[1;1Hclear")).toBe("clear");
  });

  test("strips OSC terminated by BEL or ST", () => {
    expect(sanitizeOutput("\u001B]0;title\u0007ok")).toBe("ok");
    expect(sanitizeOutput("\u001B]8;;https://x\u001B\\link")).toBe("link");
  });

  test("strips DCS and unterminated sequences", () => {
    expect(sanitizeOutput("\u001BPq junk \u001B\\tail")).toBe("tail");
    expect(sanitizeOutput("head\u001B]0;never-ends")).toBe("head");
  });

  test("strips 8-bit C1 controls", () => {
    expect(sanitizeOutput("a\u009Bb\u0090c")).toBe("abc");
  });

  test("turns tab/newline/CR into spaces and collapses runs", () => {
    expect(sanitizeOutput("a\nb\tc\r\nd")).toBe("a b c d");
    expect(sanitizeOutput("  padded   text  ")).toBe("padded text");
  });

  test("drops other control characters and DEL", () => {
    expect(sanitizeOutput("a\u0000b\u0007c\u007Fd")).toBe("abcd");
  });

  test("drops BiDi overrides", () => {
    expect(sanitizeOutput("a\u202Eb\u2066c\u200Fd")).toBe("abcd");
  });

  test("drops other Cf format and Zl/Zp separator characters", () => {
    // Cf: soft hyphen, ZWJ, word joiner, invisible times, BOM/ZWNBSP.
    expect(sanitizeOutput("a\u00ADb\u200Dc\u2060d\u2062e\uFEFFf")).toBe("abcdef");
    // Zl line separator, Zp paragraph separator.
    expect(sanitizeOutput("a\u2028b\u2029c")).toBe("abc");
  });

  test("caps terminal width", () => {
    const out = sanitizeOutput("字".repeat(200));
    expect(Bun.stringWidth(out)).toBeLessThanOrEqual(MAX_CMD_OUTPUT_WIDTH);
    expect(out.length).toBe(MAX_CMD_OUTPUT_WIDTH / 2);
  });

  test("caps bytes without splitting a code point", () => {
    const out = sanitizeOutput("🙂".repeat(500));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CMD_OUTPUT_BYTES);
    expect(out).toBe("🙂".repeat(out.length / "🙂".length));
  });

  test("empty stays empty, no escapes ever survive", () => {
    expect(sanitizeOutput("")).toBe("");
    expect(sanitizeOutput("\u001B[31m")).toBe("");
    expect(sanitizeOutput("\u001B[32mgreen")).not.toContain("\u001B");
  });
});
