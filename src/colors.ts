// Vendored tinyrainbow@3 (MIT, github.com/tinylibs/tinyrainbow) so raw
// `bun src/index.ts` runs with no node_modules (nix/brew install path).

type Formatter = ((input: unknown) => string) & { open: string; close: string };

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

// replace patches nested close codes (bold/dim share 22)
const mk = (open: number, close: number, replace?: string): Formatter =>
  enabled ? formatter(esc(open), esc(close), replace) : identity;

const colors = {
  reset: mk(0, 0),
  bold: mk(1, 22, "\u001B[22m\u001B[1m"),
  dim: mk(2, 22, "\u001B[22m\u001B[2m"),
  italic: mk(3, 23),
  underline: mk(4, 24),
  inverse: mk(7, 27),
  hidden: mk(8, 28),
  strikethrough: mk(9, 29),
  black: mk(30, 39),
  red: mk(31, 39),
  green: mk(32, 39),
  yellow: mk(33, 39),
  blue: mk(34, 39),
  magenta: mk(35, 39),
  cyan: mk(36, 39),
  white: mk(37, 39),
  gray: mk(90, 39),
  bgBlack: mk(40, 49),
  bgRed: mk(41, 49),
  bgGreen: mk(42, 49),
  bgYellow: mk(43, 49),
  bgBlue: mk(44, 49),
  bgMagenta: mk(45, 49),
  bgCyan: mk(46, 49),
  bgWhite: mk(47, 49),
  blackBright: mk(90, 39),
  redBright: mk(91, 39),
  greenBright: mk(92, 39),
  yellowBright: mk(93, 39),
  blueBright: mk(94, 39),
  magentaBright: mk(95, 39),
  cyanBright: mk(96, 39),
  whiteBright: mk(97, 39),
  bgBlackBright: mk(100, 49),
  bgRedBright: mk(101, 49),
  bgGreenBright: mk(102, 49),
  bgYellowBright: mk(103, 49),
  bgBlueBright: mk(104, 49),
  bgMagentaBright: mk(105, 49),
  bgCyanBright: mk(106, 49),
  bgWhiteBright: mk(107, 49),
};

export default colors;
