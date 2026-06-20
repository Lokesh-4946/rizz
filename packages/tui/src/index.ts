// @rizz/tui — the terminal UI (separable so headless use stays light). Zero-dependency ANSI +
// readline (decision D-015); the experience layer that must beat Hermes on editing, streaming,
// approvals, navigation. Kept out of the default headless path.

export const VERSION = '0.0.0';

export { type TuiOptions, startTui } from './tui.js';
export { type Theme, createTheme, defaultColorEnabled } from './theme.js';
export {
  type StatusInfo,
  renderEmptyState,
  renderHeader,
  renderHint,
  renderStatusBar,
} from './render.js';
