// Vendored tinyrainbow@3 (MIT, github.com/tinylibs/tinyrainbow) so raw
// `bun src/index.ts` runs with no node_modules (nix/brew install path).

type Formatter = ((input: unknown) => string) & { open: string; close: string };

// [open, close, replace?] — replace patches nested close codes (bold/dim share 22)
const CODES = {
  reset: [0, 0],
  bold: [1, 22, "\u001B[22m\u001B[1m"],
  dim: [2, 22, "\u001B[22m\u001B[2m"],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  blackBright: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgBlackBright: [100, 49],
  bgRedBright: [101, 49],
  bgGreenBright: [102, 49],
  bgYellowBright: [103, 49],
  bgBlueBright: [104, 49],
  bgMagentaBright: [105, 49],
  bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
} satisfies Record<string, [number, number] | [number, number, string]>;

// Colors default ON when piped (FORCE_TTY !== "false") — a statusline's
// consumer renders ANSI but isn't a TTY.
const isSupported = (): boolean => {
  const env = process.env;
  const argv = process.argv;
  if ("NO_COLOR" in env || argv.includes("--no-color")) return false;
  return (
    "FORCE_COLOR" in env ||
    argv.includes("--color") ||
    process.platform === "win32" ||
    (env.FORCE_TTY !== "false" && env.TERM !== "dumb") ||
    "CI" in env
  );
};

const replaceClose = (str: string, close: string, replace: string, index: number): string => {
  let result = "";
  let cursor = 0;
  do {
    result += str.substring(cursor, index) + replace;
    cursor = index + close.length;
    index = str.indexOf(close, cursor);
  } while (~index);
  return result + str.substring(cursor);
};

const formatter = (open: string, close: string, replace = open): Formatter => {
  const fn = (input: unknown): string => {
    const str = String(input);
    const index = str.indexOf(close, open.length);
    return ~index ? open + replaceClose(str, close, replace, index) + close : open + str + close;
  };
  fn.open = open;
  fn.close = close;
  return fn;
};

const identity: Formatter = Object.assign((input: unknown) => String(input), {
  open: "",
  close: "",
});

const esc = (code: number): string => `\u001B[${code}m`;
const enabled = isSupported();

const colors = Object.fromEntries(
  Object.entries(CODES).map(([name, [open, close, replace]]) => [
    name,
    enabled ? formatter(esc(open), esc(close), replace) : identity,
  ]),
) as Record<keyof typeof CODES, Formatter>;

export default colors;
