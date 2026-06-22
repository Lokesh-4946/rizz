// Theme + color-depth ladder (UI/UX spec §1, decision D-015/D-028). A theme defines a five-token
// palette + a few glyphs; layout never depends on color (spec §0.4). The renderer degrades across a
// truecolor → 256 → 16 → none ladder (D-008) so output stays legible on any terminal, and emits plain
// strings under NO_COLOR / non-TTY. The runtime `Theme` (five paint methods + name + glyphs) is what
// render helpers consume; only its construction is depth-aware.

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

export interface Theme {
  readonly name: string;
  readonly depth: ColorDepth;
  readonly glyphs: GlyphSet;
  accent(s: string): string;
  text(s: string): string;
  system(s: string): string;
  alert(s: string): string;
  dim(s: string): string;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A theme = five base tokens + bg (declared, not painted) + a name. Glyphs default unless overridden. */
export interface ThemeSpec {
  readonly name: string;
  readonly palette: {
    readonly accent: Rgb;
    readonly text: Rgb;
    readonly system: Rgb;
    readonly alert: Rgb;
    readonly dim: Rgb;
    readonly bg: Rgb;
  };
  readonly isLight?: boolean;
}

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

// The five built-ins (spec §2.1). Values are the locked palette; non-valoir themes tuned by eye.
/** @internal */
export const BUILTIN_THEMES: Readonly<Record<string, ThemeSpec>> = {
  valoir: {
    name: 'valoir',
    palette: {
      accent: rgb(227, 179, 65),
      text: rgb(237, 230, 214),
      system: rgb(95, 179, 161),
      alert: rgb(217, 138, 122),
      dim: rgb(124, 118, 104),
      bg: rgb(20, 19, 15),
    },
  },
  gruvbox: {
    name: 'gruvbox',
    palette: {
      accent: rgb(215, 153, 33),
      text: rgb(235, 219, 178),
      system: rgb(142, 192, 124),
      alert: rgb(251, 73, 52),
      dim: rgb(146, 131, 116),
      bg: rgb(40, 40, 40),
    },
  },
  nord: {
    name: 'nord',
    palette: {
      accent: rgb(136, 192, 208),
      text: rgb(236, 239, 244),
      system: rgb(163, 190, 140),
      alert: rgb(191, 97, 106),
      dim: rgb(76, 86, 106),
      bg: rgb(46, 52, 64),
    },
  },
  paper: {
    name: 'paper',
    isLight: true,
    palette: {
      accent: rgb(181, 137, 0),
      text: rgb(28, 27, 25),
      system: rgb(42, 161, 152),
      alert: rgb(220, 50, 47),
      dim: rgb(147, 161, 161),
      bg: rgb(253, 246, 227),
    },
  },
  'high-contrast': {
    name: 'high-contrast',
    palette: {
      accent: rgb(255, 212, 0),
      text: rgb(255, 255, 255),
      system: rgb(0, 255, 208),
      alert: rgb(255, 92, 92),
      dim: rgb(191, 191, 191),
      bg: rgb(0, 0, 0),
    },
  },
};

/** @internal */
export const THEME_NAMES: readonly string[] = Object.keys(BUILTIN_THEMES);

// --- Glyphs (spec §2.2): Unicode by default, ASCII fallback on the 16-color / no-color rungs. ---

export interface GlyphSet {
  readonly boxH: string;
  readonly caret: string;
  readonly bullet: string;
  readonly bulletOpen: string;
  readonly arrow: string;
  readonly selected: string;
  readonly star: string;
  readonly check: string;
  readonly cross: string;
}

const UNICODE_GLYPHS: GlyphSet = {
  boxH: '─',
  caret: '›',
  bullet: '●',
  bulletOpen: '○',
  arrow: '→',
  selected: '▸',
  star: '★',
  check: '✓',
  cross: '✗',
};

const ASCII_GLYPHS: GlyphSet = {
  boxH: '-',
  caret: '>',
  bullet: '*',
  bulletOpen: 'o',
  arrow: '->',
  selected: '>',
  star: '*',
  check: '[ok]',
  cross: '[x]',
};

// --- Color quantization (computed once per theme construction — not per render; lightweight). ---

const clamp5 = (v: number): number => Math.round((v / 255) * 5);

/** Nearest xterm-256 index for an rgb value (6×6×6 cube + grayscale ramp). */
function to256(c: Rgb): number {
  if (c.r === c.g && c.g === c.b) {
    if (c.r < 8) return 16;
    if (c.r > 248) return 231;
    return Math.round(((c.r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * clamp5(c.r) + 6 * clamp5(c.g) + clamp5(c.b);
}

// The 16 ANSI base colors (SGR 30-37, 90-97) with approximate rgb, for nearest-match on the 16 rung.
const ANSI16: readonly { code: number; rgb: Rgb }[] = [
  { code: 30, rgb: rgb(0, 0, 0) },
  { code: 31, rgb: rgb(205, 49, 49) },
  { code: 32, rgb: rgb(13, 188, 121) },
  { code: 33, rgb: rgb(229, 229, 16) },
  { code: 34, rgb: rgb(36, 114, 200) },
  { code: 35, rgb: rgb(188, 63, 188) },
  { code: 36, rgb: rgb(17, 168, 205) },
  { code: 37, rgb: rgb(229, 229, 229) },
  { code: 90, rgb: rgb(102, 102, 102) },
  { code: 91, rgb: rgb(241, 76, 76) },
  { code: 92, rgb: rgb(35, 209, 139) },
  { code: 93, rgb: rgb(245, 245, 67) },
  { code: 94, rgb: rgb(59, 142, 234) },
  { code: 95, rgb: rgb(214, 112, 214) },
  { code: 96, rgb: rgb(41, 184, 219) },
  { code: 97, rgb: rgb(255, 255, 255) },
];

function to16(c: Rgb): number {
  let bestCode = 37; // default to plain white if the table were ever empty
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entry of ANSI16) {
    const dr = entry.rgb.r - c.r;
    const dg = entry.rgb.g - c.g;
    const db = entry.rgb.b - c.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestCode = entry.code;
    }
  }
  return bestCode;
}

/** Build the paint function for one token at the resolved depth. */
function painter(depth: ColorDepth, color: Rgb): (s: string) => string {
  switch (depth) {
    case 'truecolor':
      return (s) => `\x1b[38;2;${color.r};${color.g};${color.b}m${s}\x1b[0m`;
    case '256':
      return (s) => `\x1b[38;5;${to256(color)}m${s}\x1b[0m`;
    case '16':
      return (s) => `\x1b[${to16(color)}m${s}\x1b[0m`;
    case 'none':
      return (s) => s;
  }
}

export interface CreateThemeOptions {
  /** Resolved color depth. Takes precedence over `color`. */
  readonly depth?: ColorDepth;
  /** Back-compat: true ≡ depth 'truecolor', false ≡ depth 'none'. */
  readonly color?: boolean;
  /** Theme spec or a built-in name. Defaults to valoir. */
  readonly spec?: ThemeSpec | string;
}

function resolveDepth(options: CreateThemeOptions): ColorDepth {
  if (options.depth !== undefined) return options.depth;
  if (options.color === true) return 'truecolor';
  if (options.color === false) return 'none';
  return detectColorDepth();
}

function resolveSpec(spec: ThemeSpec | string | undefined): ThemeSpec {
  if (spec === undefined) return BUILTIN_THEMES.valoir as ThemeSpec;
  if (typeof spec === 'string') return BUILTIN_THEMES[spec] ?? (BUILTIN_THEMES.valoir as ThemeSpec);
  return spec;
}

export const createTheme = (options: CreateThemeOptions = {}): Theme => {
  const depth = resolveDepth(options);
  const spec = resolveSpec(options.spec);
  const p = spec.palette;
  // Unicode glyphs on the richer rungs; ASCII where width/encoding is least reliable (spec §2.2).
  const glyphs = depth === 'truecolor' || depth === '256' ? UNICODE_GLYPHS : ASCII_GLYPHS;
  return {
    name: spec.name,
    depth,
    glyphs,
    accent: painter(depth, p.accent),
    text: painter(depth, p.text),
    system: painter(depth, p.system),
    alert: painter(depth, p.alert),
    dim: painter(depth, p.dim),
  };
};

/** Detect the terminal's color depth once at startup (spec §1.2). NO_COLOR / non-TTY → 'none'. */
/** @internal */
export const detectColorDepth = (): ColorDepth => {
  if (process.env.NO_COLOR !== undefined || process.stdout.isTTY !== true) return 'none';
  const colorterm = process.env.COLORTERM ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  const term = process.env.TERM ?? '';
  if (term.includes('256color')) return '256';
  return '16';
};

/** Color on only when stdout is a real TTY and NO_COLOR is unset (https://no-color.org). */
export const defaultColorEnabled = (): boolean => detectColorDepth() !== 'none';
