import { MAX_CMD_OUTPUT_BYTES, MAX_CMD_OUTPUT_WIDTH } from "./constants.ts";

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const DEL = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const SPACE = 0x20;

// OSC/DCS/SOS/PM/APC introducers: these run until a string terminator.
const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);
const SPACE_CODES = new Set([0x09, 0x0a, 0x0d]);
// Every invisible formatting character (Cf covers BiDi controls, joiners, and
// The BOM) plus the line/paragraph separators, which would otherwise break the
// Statusline across rows. Matched per code point so astral ones are dropped
// Whole rather than leaving a lone surrogate behind.
const INVISIBLE_RE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;

const isStringTerminator = (text: string, i: number): boolean =>
  text.charCodeAt(i) === BEL ||
  (text.charCodeAt(i) === ESC && text.charCodeAt(i + 1) === BACKSLASH);

const skipStringSequence = (text: string, start: number): number => {
  let i = start + 2;
  while (i < text.length && !isStringTerminator(text, i)) i += 1;
  if (i >= text.length) return text.length;
  return text.charCodeAt(i) === BEL ? i + 1 : i + 2;
};

const skipCsi = (text: string, start: number): number => {
  let i = start + 2;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) return i + 1;
    if (code < SPACE) return i;
    i += 1;
  }
  return text.length;
};

// Index just past the escape sequence starting at `start`. Unterminated
// Sequences swallow the rest of the string, so nothing can leak out.
const skipEscape = (text: string, start: number): number => {
  const kind = text[start + 1] ?? "";
  if (STRING_INTRODUCERS.has(kind)) return skipStringSequence(text, start);
  if (kind === "[") return skipCsi(text, start);
  return start + 2;
};

const isDropped = (code: number): boolean =>
  (code >= C1_START && code <= C1_END) || code < SPACE || code === DEL;

// Strip every escape, control, and BiDi form; tab/newline/CR become spaces so
// The result is always a single statusline segment.
const stripUnsafe = (raw: string): string => {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === ESC) {
      i = skipEscape(raw, i);
    } else if (SPACE_CODES.has(code)) {
      out += " ";
      i += 1;
    } else if (isDropped(code)) {
      i += 1;
    } else {
      out += raw[i];
      i += 1;
    }
  }
  return out;
};

// Bound both terminal width and bytes, always on a code-point boundary.
const capOutput = (text: string): string => {
  let width = 0;
  let bytes = 0;
  let out = "";
  for (const cp of text) {
    const cpWidth = Bun.stringWidth(cp);
    const cpBytes = Buffer.byteLength(cp, "utf8");
    if (width + cpWidth > MAX_CMD_OUTPUT_WIDTH || bytes + cpBytes > MAX_CMD_OUTPUT_BYTES) break;
    width += cpWidth;
    bytes += cpBytes;
    out += cp;
  }
  return out;
};

// Custom command output is untrusted text injected into a shared statusline
// Row. No escape survives, so NO_COLOR holds by construction.
export const sanitizeOutput = (raw: string): string =>
  capOutput(
    Bun.stripANSI(stripUnsafe(raw)).replace(INVISIBLE_RE, "").replace(/ {2,}/g, " ").trim(),
  );
