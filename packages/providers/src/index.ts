// @rizz/providers — the service layer (the "how": provider/SDK calls, tool execution,
// readiness checks). Returns structured results; never throws for expected failures; never
// mutates orchestration state. See CLAUDE.md §Architecture.

export const VERSION = '0.0.0';

export {
  type RizzErrorCode,
  RizzError,
  type Result,
  ok,
  err,
} from './result.js';
export type {
  Role,
  Message,
  CompletionRequest,
  CompletionResult,
  Provider,
} from './provider.js';
export { StubProvider } from './stub-provider.js';
