// The runtime service surface (the four tools + dispatch + the primitives they share). Provider-
// agnostic mechanics; everything here takes explicit params and returns Result<T> (ADR-001).

export { contentHash } from './hash.js';
export { type Eol, applyEol, detectEol } from './eol.js';
export { type VerifiedWrite, verifyWrite } from './verify.js';
export { resolveWorkspacePath, expandHome } from './platform/path.js';
export { type ReadParams, type ReadResult, readTool } from './tools/read.js';
export { type WriteParams, type WriteResult, writeTool } from './tools/write.js';
export { type EditParams, type EditResult, editTool } from './tools/edit.js';
export {
  type BashParams,
  type BashResult,
  type Classification,
  type CommandClass,
  classifyCommand,
  runBash,
} from './tools/bash.js';
export { type ToolSpec, TOOL_SPECS } from './tools/spec.js';
export {
  type ApprovalDecision,
  type ApprovalRequest,
  type DispatchToolParams,
  type ToolCall,
  type ToolResult,
  dispatchTool,
} from './dispatch.js';
