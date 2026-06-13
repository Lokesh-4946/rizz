// Valoir theme — gold accent on warm ink (UI/UX spec §0). Truecolor ANSI. A theme defines only the
// palette; layout never depends on color (spec §0.4). `color: false` yields plain strings so render
// functions stay deterministic and testable, and so NO_COLOR / non-TTY output is clean.

export interface Theme {
  readonly name: string;
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

const VALOIR = {
  accent: { r: 227, g: 179, b: 65 }, // gold  #E3B341
  text: { r: 237, g: 230, b: 214 }, //  bone  #EDE6D6
  system: { r: 95, g: 179, b: 161 }, // teal  #5FB3A1
  alert: { r: 217, g: 138, b: 122 }, // rose  #D98A7A
  dim: { r: 124, g: 118, b: 104 }, //   muted
} as const;

const paint = (color: boolean, rgb: Rgb, s: string): string =>
  color ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${s}\x1b[0m` : s;

export const createTheme = (options: { color: boolean }): Theme => {
  const { color } = options;
  return {
    name: 'valoir',
    accent: (s) => paint(color, VALOIR.accent, s),
    text: (s) => paint(color, VALOIR.text, s),
    system: (s) => paint(color, VALOIR.system, s),
    alert: (s) => paint(color, VALOIR.alert, s),
    dim: (s) => paint(color, VALOIR.dim, s),
  };
};

/** Color on only when stdout is a real TTY and NO_COLOR is unset (https://no-color.org). */
export const defaultColorEnabled = (): boolean =>
  process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
