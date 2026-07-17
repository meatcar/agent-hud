import colors from "./colors.ts";

import {
  BAR_SIDE_MARGIN,
  CTX_BAR_WIDTH,
  CTX_CRIT_USED,
  CTX_WARN_USED,
  EIGHTHS,
  EIGHTHS_PER_CELL,
  ICON_5H,
  ICON_7D,
  ICON_CLOCK,
  ICON_MISS,
  ICON_WILTED,
  LIMIT_BAR_WIDTH,
  LIMIT_CRIT_BURN_RATIO,
  MARKER_TICK,
  MAX_BAR_GROWTH,
  MISS_CRIT,
  MISS_WARN,
  MS_PER_MIN,
  PERCENT,
  SEC_PER_MIN,
} from "./constants.ts";
import { burnSeconds, formatDuration, toEpoch } from "./helpers.ts";
import { intrinsicWidthAround, layoutLabelsAround } from "./label-layout.ts";
import { formatTime } from "./render.ts";

type ColorFn = (str: string) => string;

export interface Tone {
  bg: ColorFn;
  fg: ColorFn;
  text: ColorFn;
  // Override rendering of the partial-block character at the fill/bg boundary.
  // Receives the fill tone's bg function and the block char string.
  // Default: bgTone.bg(fillTone.fg(char))
  renderBlock?: (fillBg: ColorFn, char: string) => string;
}

export const makeTone = (bg: ColorFn, fg: ColorFn, text: ColorFn): Tone => ({ bg, fg, text });

const bold =
  (fn: ColorFn): ColorFn =>
  (str) =>
    colors.bold(fn(str));
const GREY: Tone = {
  bg: colors.inverse,
  fg: colors.dim,
  text: colors.bold,
  // Set fill color as the ANSI background BEFORE applying inverse so the block
  // Character renders correctly: solid side = fill color, empty side = terminal-fg (bar bg).
  renderBlock: (fillBg, char) => fillBg(colors.inverse(char)),
};
const GREEN = makeTone(colors.bgGreen, colors.green, bold(colors.whiteBright));
export const YELLOW = makeTone(colors.bgYellow, colors.yellow, bold(colors.whiteBright));
export const RED = makeTone(colors.bgRed, colors.red, bold(colors.whiteBright));
export const LIGHTBLUE = makeTone(colors.bgBlue, colors.blue, bold(colors.whiteBright));
export const BLUE = makeTone(colors.bgBlue, colors.blue, bold(colors.whiteBright));

export const groupCaps = (inner: string, tone: Tone): string => tone.bg(inner);

export interface LeadingEdge {
  pct: number;
  tone: Tone;
}

export interface BarMarker {
  // Position along the full bar as a percentage (0-100). Drawn as a single
  // Recolored cell, only when the bar fill (pct) exceeds pctPos.
  pctPos: number;
  tone: Tone;
}

export interface FractionalBarOpts {
  pct: number;
  labels: string[];
  minWidth?: number;
  fillTone: Tone;
  bgTone?: Tone;
  leadingEdge?: LeadingEdge;
  marker?: BarMarker;
}

interface ResolvedMarker {
  cell: number;
  tone: Tone;
}

interface BarRenderState {
  content: string;
  full: number;
  partial: number;
  hasPartial: boolean;
  edgeStart: number;
  edgeEighths: number;
  edgeTone: Tone | undefined;
}

interface BarContext {
  pct: number;
  labels: string[];
  margin: number;
  fillTone: Tone;
  bgTone: Tone;
  leadingEdge: LeadingEdge | undefined;
  marker: BarMarker | undefined;
}

const computeEdgeBoundaries = ({
  hasPartial,
  edgeStart,
  edgeEighths,
  edgeTone,
  full,
}: BarRenderState): { edgeBoundaryCell: number; edgeSolidStart: number } => {
  // Sub-cell edge + fill partial: suppress boundary cell to avoid width overflow and
  // Unnecessary edge coloring in the fill zone; the partial char carries the edge fg.
  const edgeBoundaryCell =
    edgeTone !== undefined &&
    edgeEighths > 0 &&
    edgeStart % EIGHTHS_PER_CELL !== 0 &&
    (edgeEighths >= EIGHTHS_PER_CELL || !hasPartial)
      ? Math.floor(edgeStart / EIGHTHS_PER_CELL)
      : -1;
  let edgeSolidStart: number;
  if (edgeBoundaryCell >= 0) {
    edgeSolidStart = edgeBoundaryCell + 1;
  } else if (edgeEighths >= EIGHTHS_PER_CELL || !hasPartial) {
    edgeSolidStart = Math.floor(edgeStart / EIGHTHS_PER_CELL);
  } else {
    edgeSolidStart = full;
  }
  return { edgeBoundaryCell, edgeSolidStart };
};

// Render the marker as a slim vertical tick recolored in the marker's foreground
// Tone over the underlying run's background — a gridline at the boundary, not a
// Full block, so the bar reads slimmer. The marker cell is reserved during layout
// So no label glyph is displaced.
const markerCell = (markerTone: Tone, underTone: Tone): string =>
  underTone.bg(markerTone.fg(MARKER_TICK));

// Paint cells [start, end) in `tone`. If the marker lands inside the run, that
// Single cell is recolored in the marker tone, splitting the run around it.
const paintRun = (
  content: string,
  start: number,
  end: number,
  tone: Tone,
  marker: ResolvedMarker | undefined,
): string => {
  if (end <= start) {
    return "";
  }
  if (marker === undefined || marker.cell < start || marker.cell >= end) {
    return tone.bg(tone.text(content.slice(start, end)));
  }
  const before = content.slice(start, marker.cell);
  const after = content.slice(marker.cell + 1, end);
  return (
    (before ? tone.bg(tone.text(before)) : "") +
    markerCell(marker.tone, tone) +
    (after ? tone.bg(tone.text(after)) : "")
  );
};

// The boundary cell where a sub-cell edge starts: marker wins, else a partial
// Block glyph carrying the edge fg over the fill bg.
const renderEdgeBoundary = (
  state: BarRenderState,
  fillTone: Tone,
  edgeBoundaryCell: number,
  marker: ResolvedMarker | undefined,
): string => {
  if (edgeBoundaryCell < 0) {
    return "";
  }
  const { edgeStart, edgeTone } = state;
  return marker?.cell === edgeBoundaryCell
    ? markerCell(marker.tone, edgeTone ?? fillTone)
    : (edgeTone ?? fillTone).bg(fillTone.fg(EIGHTHS[edgeStart % EIGHTHS_PER_CELL] ?? " "));
};

// The partial cell at the fill/bg boundary: marker wins, else an eighths glyph.
const renderLeadingEdge = (
  state: BarRenderState,
  fillTone: Tone,
  bgTone: Tone,
  marker: ResolvedMarker | undefined,
): string => {
  const { full, partial, hasPartial, edgeEighths, edgeTone } = state;
  if (!hasPartial) {
    return "";
  }
  if (marker?.cell === full) {
    return markerCell(marker.tone, bgTone);
  }
  const fgTone = edgeTone !== undefined && edgeEighths > 0 ? edgeTone : fillTone;
  const char = EIGHTHS[partial] ?? " ";
  return bgTone.renderBlock ? bgTone.renderBlock(fgTone.bg, char) : bgTone.bg(fgTone.fg(char));
};

const renderBarContent = (
  state: BarRenderState,
  fillTone: Tone,
  bgTone: Tone,
  marker?: ResolvedMarker,
): string => {
  const { content, full, hasPartial, edgeTone } = state;
  const { edgeBoundaryCell, edgeSolidStart } = computeEdgeBoundaries(state);
  const fillEnd = edgeBoundaryCell >= 0 ? edgeBoundaryCell : edgeSolidStart;
  return (
    paintRun(content, 0, fillEnd, fillTone, marker) +
    renderEdgeBoundary(state, fillTone, edgeBoundaryCell, marker) +
    paintRun(content, edgeSolidStart, full, edgeTone ?? fillTone, marker) +
    renderLeadingEdge(state, fillTone, bgTone, marker) +
    paintRun(content, full + (hasPartial ? 1 : 0), content.length, bgTone, marker)
  );
};

interface BarGeometry {
  full: number;
  partial: number;
  hasPartial: boolean;
  edgeStart: number;
  edgeEighths: number;
  edgeBoundaryCell: number;
}

const computeGeometry = (width: number, ctx: BarContext): BarGeometry => {
  const totalEighths = Math.round((ctx.pct * width * EIGHTHS_PER_CELL) / PERCENT);
  const full = Math.floor(totalEighths / EIGHTHS_PER_CELL);
  const partial = totalEighths % EIGHTHS_PER_CELL;
  const hasPartial = partial > 0 && full < width;
  const edgeEighths = ctx.leadingEdge
    ? Math.round((ctx.leadingEdge.pct * totalEighths) / PERCENT)
    : 0;
  const edgeStart = totalEighths - edgeEighths;
  const edgeBoundaryCell =
    ctx.leadingEdge &&
    edgeEighths > 0 &&
    edgeStart % EIGHTHS_PER_CELL !== 0 &&
    (edgeEighths >= EIGHTHS_PER_CELL || !hasPartial)
      ? Math.floor(edgeStart / EIGHTHS_PER_CELL)
      : -1;
  return { full, partial, hasPartial, edgeStart, edgeEighths, edgeBoundaryCell };
};

const resolveMarker = (width: number, ctx: BarContext): ResolvedMarker | undefined =>
  ctx.marker !== undefined && ctx.pct > ctx.marker.pctPos
    ? {
        cell: Math.min(width - 1, Math.floor((ctx.marker.pctPos / PERCENT) * width)),
        tone: ctx.marker.tone,
      }
    : undefined;

const tryFitWidth = (width: number, ctx: BarContext, force = false): string | undefined => {
  const { full, partial, hasPartial, edgeStart, edgeEighths, edgeBoundaryCell } = computeGeometry(
    width,
    ctx,
  );
  const marker = resolveMarker(width, ctx);
  const reserved = [
    hasPartial ? full : -1,
    edgeBoundaryCell < full ? edgeBoundaryCell : -1,
    marker?.cell ?? -1,
  ].filter((cell) => cell >= 0);
  const content = layoutLabelsAround({ width, labels: ctx.labels, reserved, margin: ctx.margin });
  if (!force && !ctx.labels.every((lbl) => lbl.length === 0 || content.includes(lbl))) {
    return undefined;
  }
  return renderBarContent(
    {
      content,
      full,
      partial,
      hasPartial,
      edgeStart,
      edgeEighths,
      edgeTone: ctx.leadingEdge?.tone,
    },
    ctx.fillTone,
    ctx.bgTone,
    marker,
  );
};

export const fractionalBar = ({
  pct,
  labels,
  minWidth = CTX_BAR_WIDTH,
  fillTone,
  bgTone = GREY,
  leadingEdge,
  marker,
}: FractionalBarOpts): string => {
  const ctx: BarContext = {
    pct,
    labels,
    margin: BAR_SIDE_MARGIN,
    fillTone,
    bgTone,
    leadingEdge,
    marker,
  };
  const start = Math.max(minWidth, intrinsicWidthAround(labels, [0], BAR_SIDE_MARGIN));
  for (let width = start; width <= start + MAX_BAR_GROWTH; width += 1) {
    const result = tryFitWidth(width, ctx);
    if (result !== undefined) {
      return result;
    }
  }
  // Layout bug guard: render with possibly-clipped labels rather than loop forever.
  return tryFitWidth(start, ctx, true) ?? "";
};

const missColor = (pct: number): ColorFn => {
  if (pct >= MISS_CRIT) {
    return colors.red;
  }
  if (pct >= MISS_WARN) {
    return colors.yellow;
  }
  return colors.green;
};

export const missPill = (missPct: number): string => {
  const clamped = Math.max(0, Math.min(PERCENT, Math.round(missPct)));
  return `${colors.dim(ICON_MISS)} ${missColor(clamped)(`${clamped}%`)}`;
};

const ctxFillTone = (pct: number): Tone => {
  if (pct >= CTX_CRIT_USED) {
    return RED;
  }
  if (pct >= CTX_WARN_USED) {
    return YELLOW;
  }
  return GREEN;
};

export const missTone = (missPct: number): Tone => (missPct >= MISS_CRIT ? RED : YELLOW);

const cacheLeaf = (missPct: number): string => {
  if (missPct >= MISS_CRIT) {
    return "🔥";
  }
  if (missPct >= MISS_WARN) {
    return "🍂";
  }
  return "🌿";
};

export interface CtxSegmentParams {
  used: number | undefined;
  sessionStart: number | undefined;
  cacheMissPct: number | undefined;
  now: number;
  // When set (1M-context models), draw a marker at this % of the bar once exceeded.
  markerPct?: number;
  // Prompt-cache TTL and last API request epoch; drives the countdown + wilt.
  ttlSecs?: number;
  lastActivity?: number;
}

// Leaf + countdown until the prompt cache goes cold; wilts once past the TTL.
const cacheBadge = (
  missPct: number | undefined,
  ttlSecs: number | undefined,
  lastActivity: number | undefined,
  now: number,
): string => {
  if (missPct === undefined) {
    return "";
  }
  const expiresIn =
    ttlSecs !== undefined && lastActivity !== undefined ? lastActivity + ttlSecs - now : undefined;
  if (expiresIn !== undefined && expiresIn <= 0) {
    return `${ICON_WILTED}  `;
  }
  // Minutes only: the TTL tops out at 1h, so "60m" is the widest label.
  const countdown =
    expiresIn !== undefined ? ` ${colors.dim(`${Math.ceil(expiresIn / SEC_PER_MIN)}m`)}` : "";
  return `${cacheLeaf(missPct)}${countdown}  `;
};

export const renderCtxSegment = ({
  used,
  sessionStart,
  cacheMissPct,
  now,
  markerPct,
  ttlSecs,
  lastActivity,
}: CtxSegmentParams): string => {
  if (used === undefined) {
    return "";
  }
  const elapsed = sessionStart !== undefined ? now - sessionStart : undefined;
  const eta = formatDuration(burnSeconds(used, elapsed)) ?? "";
  const missLabel = cacheMissPct !== undefined ? `${Math.round(cacheMissPct)}%` : undefined;
  const labels = [missLabel, `${Math.round(used)}%`, eta].filter(
    (lbl): lbl is string => lbl !== undefined && lbl !== "",
  );
  const leaf = cacheBadge(cacheMissPct, ttlSecs, lastActivity, now);
  const leadingEdge =
    cacheMissPct !== undefined && cacheMissPct > 0
      ? { pct: cacheMissPct, tone: missTone(cacheMissPct) }
      : undefined;
  const marker = markerPct !== undefined ? { pctPos: markerPct, tone: RED } : undefined;
  return (
    leaf + fractionalBar({ pct: used, labels, fillTone: ctxFillTone(used), leadingEdge, marker })
  );
};

export interface LimitOpts {
  pct: number | undefined;
  resetAt: string | number | undefined;
  windowSecs: number;
  now: number;
}

export interface LimitBurn {
  burn: number | undefined;
  resetSecs: number | undefined;
}

export const computeLimitBurn = (pct: number, opts: LimitOpts): LimitBurn => {
  const epoch = toEpoch(opts.resetAt);
  if (epoch === undefined) {
    return { burn: undefined, resetSecs: undefined };
  }
  const resetSecs = epoch - opts.now;
  const elapsed = opts.windowSecs - resetSecs;
  return { burn: elapsed > 0 ? burnSeconds(pct, elapsed) : undefined, resetSecs };
};

export const limitFillTone = (
  burn: number | undefined,
  resetSecs: number | undefined,
  base: Tone,
): Tone => {
  if (burn === undefined || resetSecs === undefined || burn >= resetSecs) {
    return base;
  }
  if (burn < resetSecs * LIMIT_CRIT_BURN_RATIO) {
    return RED;
  }
  return YELLOW;
};

const limitLabel = ({ burn, resetSecs }: LimitBurn): string => {
  if (resetSecs === undefined) {
    return "";
  }
  const burnFast = burn !== undefined && burn < resetSecs;
  return formatDuration(burnFast ? burn : Math.max(0, resetSecs)) ?? "";
};

const buildLimitPart = (opts: LimitOpts, base: Tone, windowSuffix: string): string => {
  if (opts.pct === undefined) {
    // Match the rendered width (bar + "/5h" suffix) so the clock doesn't shift.
    return " ".repeat(LIMIT_BAR_WIDTH + windowSuffix.length + 1);
  }
  const burnInfo = computeLimitBurn(opts.pct, opts);
  const timeStr = limitLabel(burnInfo);
  const labels = [`${Math.round(opts.pct)}%`, timeStr].filter((lbl) => lbl !== "");
  const bar = fractionalBar({
    pct: opts.pct,
    labels,
    minWidth: LIMIT_BAR_WIDTH,
    fillTone: limitFillTone(burnInfo.burn, burnInfo.resetSecs, base),
  });
  return `${bar}${colors.dim(`/${windowSuffix}`)}`;
};

export const renderRateLimitsGroup = ({
  five,
  seven,
}: {
  five: LimitOpts;
  seven: LimitOpts;
}): string => {
  if (five.pct === undefined && seven.pct === undefined) {
    return "";
  }
  return `${buildLimitPart(five, LIGHTBLUE, ICON_5H)} ${buildLimitPart(seven, BLUE, ICON_7D)}`;
};

// Rendered output persists until the next refresh tick (~60s), and ticks are
// Not aligned to minute boundaries — round to the nearest minute so the
// Displayed clock tracks the system clock within ±30s instead of lagging -59s.
export const renderClockGroup = (now: Date): string => {
  const rounded = new Date(Math.round(now.getTime() / MS_PER_MIN) * MS_PER_MIN);
  return ` ${colors.dim(ICON_CLOCK)}  ${colors.yellow(formatTime(rounded))} `;
};
