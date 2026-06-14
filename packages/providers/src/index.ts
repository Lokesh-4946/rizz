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

// Runtime services — the four tools, dispatch, and the primitives they share (design §2, §3.2).
export {
  type ApprovalDecision,
  type ApprovalRequest,
  type BashParams,
  type BashResult,
  type Classification,
  type CommandClass,
  type DispatchToolParams,
  type EditParams,
  type EditResult,
  type Eol,
  type ReadParams,
  type ReadResult,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
  type VerifiedWrite,
  type WriteParams,
  type WriteResult,
  TOOL_SPECS,
  applyEol,
  classifyCommand,
  contentHash,
  detectEol,
  dispatchTool,
  editTool,
  expandHome,
  readTool,
  resolveWorkspacePath,
  runBash,
  verifyWrite,
  writeTool,
} from './runtime/index.js';

// Model layer (ADR-002 Tier 1): static registry + default-and-fallback routing. Tier 2 deferred.
export {
  type Capability,
  type ModelInfo,
  type ModelRegistry,
  DEFAULT_REGISTRY,
  estimateCostUsd,
  getModel,
  listToolCapable,
} from './model/registry.js';
export {
  type RouteDecision,
  type RouteParams,
  type RouteRequest,
  type RoutingPolicy,
  DEFAULT_POLICY,
  resolveModelRoute,
} from './model/route.js';
export { type CallModelParams, type ModelReply, callModel } from './model/call.js';

// Compression service (design §3.3) + token estimation.
export { type CompressParams, type CompressResult, compressContext } from './compress.js';
export { estimateMessagesTokens, estimateTokens } from './tokens.js';

// Session persistence (design §3.5, D-020): node:sqlite primary, JSONL fallback.
export {
  type MetaPatch,
  type OpenStoreOptions,
  type SessionEngine,
  type SessionInit,
  type SessionMeta,
  type SessionStore,
  type StoredSession,
  openSessionStore,
  sqliteAvailable,
} from './session/store.js';
