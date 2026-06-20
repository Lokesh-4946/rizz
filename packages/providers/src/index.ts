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

// Real model adapter (BYOK over the Anthropic Messages API). The subscription OAuth path is not wired.
export {
  type AnthropicProviderOptions,
  type AnthropicRequestBody,
  buildAnthropicRequest,
  createAnthropicProvider,
} from './providers/anthropic.js';
// BYOK over any OpenAI-compatible endpoint (OpenAI / OpenRouter / Ollama / custom). No subscription.
export {
  type OpenAiProviderOptions,
  type OpenAiRequestBody,
  buildOpenAiRequest,
  createOpenAiProvider,
} from './providers/openai.js';
// Subscription-backed local Codex CLI bridge. Codex owns auth/session refresh.
export { createCodexCliProvider } from './providers/codex-cli.js';

// Secret storage (the BYOK key, kept off the repo/logs — §3.6): OS keychain with a 0600 file fallback.
export {
  type OpenSecretStoreOptions,
  type RunResult,
  type Runner,
  type SecretBackend,
  type SecretRef,
  type SecretStore,
  ANTHROPIC_ACCOUNT,
  RIZZ_SERVICE,
  libsecretArgs,
  macosArgs,
  openSecretStore,
} from './secrets/keychain.js';

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
  CAPABILITIES,
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
// Model layer (ADR-002 Tier 2 / D-023): declarative profiles + local-first secrets-free registry.
export {
  type Profile,
  type ResolvedProfile,
  type ThinkingLevel,
  BUILTIN_PROFILES,
  PROFILE_NAMES,
  resolveProfile,
} from './model/profiles.js';
export {
  type LoadRegistryOptions,
  type LoadedRegistry,
  REGISTRY_VERSION,
  loadRegistry,
} from './model/registry-store.js';
// Opt-in capability/cost/latency router (ADR-002 §6 / D-023) — off the default path; never "smart routing".
export {
  type CapabilityRequest,
  type CapabilityRoute,
  type CapabilityRouteParams,
  type ScoreFn,
  selectByCapability,
} from './model/capability-route.js';

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
