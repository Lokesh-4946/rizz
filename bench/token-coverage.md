# Hook token-usage coverage

Product commit under measurement: `c1d12483403461ef6795f91d67daf7a3952d7a20` (`dev`, merge of PR #198).

Docs were read on 2026-10-30. Status is `present`, `absent`, or `unknown`.

- **present** — the cited official page puts this field on the hook input.
- **absent** — the cited page lists that event's input and does not include a token-usage field, or a live payload from this VM has no such field.
- **unknown** — a first-party source disagrees with the published schema, and this VM did not capture a live payload.

## What was actually captured

| Host | Version | Result |
| --- | --- | --- |
| Claude Code | 2.1.314 (`@anthropic-ai/claude-code`) | Installed. `claude -p` with no credentials ended `Not logged in · Please run /login`. Live hook stdin was captured for `SessionStart`, `UserPromptSubmit`, and `SessionEnd`. `Stop`, `PreCompact`, and `PostToolUse` did not fire. |
| Codex CLI | 0.166.0 (`@openai/codex`) | Installed. `codex exec` with no credentials returned HTTP 401 (`Missing bearer or basic authentication`). With `--dangerously-bypass-hook-trust`, live stdin was captured for `SessionStart`, `UserPromptSubmit`, and `SessionEnd`. `Stop`, `PreCompact`, and `PostToolUse` did not fire. Codex logged the tee hooks as Failed because tee copied stdin to stdout; the files below are still the hook input. |
| Cursor | not installed | No editor in this VM. Cursor rows are from the docs, plus one staff forum reply. No live Cursor payload. |

Captured and reconstructed payloads live in `bench/payloads/`. A file marked `synthetic` or `staff-reported` is not a payload this run recorded.

`claude -p --output-format json` also prints a top-level `usage` object (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). On the unauthenticated run every count was 0. That object is the CLI result, not a hook payload.

Codex turn usage is on `codex exec --json` event `turn.completed`, field `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `cache_write_input_tokens` in the Rust struct). That is not a hook. Source: [Non-interactive mode](https://developers.openai.com/codex/noninteractive) and [`Usage` in exec_events.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs).

## Table

Rizz installs the events listed in `packages/brain/src/observe/install.ts` (`CURSOR_HOOK_EVENTS`, `CODEX_HOOK_EVENTS`, `CLAUDE_HOOK_EVENTS`). Extra rows are events the host documents as carrying token fields that Rizz does not subscribe to.

| Host | Event | Usage field | Status | Evidence |
| --- | --- | --- | --- | --- |
| cursor | preCompact | `context_tokens` | present | [Hooks](https://cursor.com/docs/hooks) input example and field table. Synthetic copy: `payloads/cursor-preCompact.synthetic.json`. |
| cursor | preCompact | `context_window_size` | present | Same page. |
| cursor | preCompact | `context_usage_percent` | present | Same page. Count of window occupancy, not a turn's input/output split. |
| cursor | stop | `input_tokens` | unknown | Published input is only `status` and `loop_count` ([Hooks](https://cursor.com/docs/hooks)). A Cursor staff reply says optional `input_tokens`, `output_tokens`, `cache_read_tokens`, and `cache_write_tokens` are sent and are omitted from that page ([forum](https://forum.cursor.com/t/how-to-obtain-token-usage-per-request/168317)). Not captured here. |
| cursor | stop | `output_tokens` | unknown | Same staff reply. Not in the published schema. Not captured here. |
| cursor | stop | `cache_read_tokens` | unknown | Same staff reply. Not in the published schema. Not captured here. |
| cursor | stop | `cache_write_tokens` | unknown | Same staff reply. Not in the published schema. Not captured here. |
| cursor | afterAgentResponse | `input_tokens` | unknown | Published input is only `text` ([Hooks](https://cursor.com/docs/hooks)). The same staff reply says the four stop token fields are also on `afterAgentResponse`. Not captured here. |
| cursor | afterAgentResponse | `output_tokens` | unknown | Same. |
| cursor | afterAgentResponse | `cache_read_tokens` | unknown | Same. |
| cursor | afterAgentResponse | `cache_write_tokens` | unknown | Same. |
| cursor | sessionStart | token counts | absent | Published input is `session_id`, `is_background_agent`, `composer_mode`. No token field. [Hooks](https://cursor.com/docs/hooks). |
| cursor | sessionEnd | token counts | absent | Published input has `duration_ms` and `reason`, not token counts. [Hooks](https://cursor.com/docs/hooks). |
| cursor | beforeSubmitPrompt | token counts | absent | Published input is `prompt` and `attachments`. [Hooks](https://cursor.com/docs/hooks). |
| cursor | afterFileEdit | token counts | absent | Published input is `file_path` and `edits`. [Hooks](https://cursor.com/docs/hooks). |
| cursor | afterShellExecution | token counts | absent | The hooks reference does not list token fields on this event. [Hooks](https://cursor.com/docs/hooks). |
| cursor | postToolUse | token counts | absent | Published extras are `duration` and `tool_output`, not token counts. [Hooks](https://cursor.com/docs/hooks). |
| cursor | subagentStart | token counts | absent | No token field in the published input. [Hooks](https://cursor.com/docs/hooks). |
| cursor | subagentStop | token counts | absent | Published counters are `duration_ms`, `message_count`, and `tool_call_count`, not model tokens. [Hooks](https://cursor.com/docs/hooks). |
| codex | SessionStart | token counts | absent | Live capture has `model` and `source` and no usage object. Official field list matches. [Hooks](https://learn.chatgpt.com/docs/hooks). `payloads/codex-0.166.0-SessionStart.captured.json`. |
| codex | UserPromptSubmit | token counts | absent | Live capture has `prompt` and `turn_id` only, plus common fields. [Hooks](https://learn.chatgpt.com/docs/hooks). `payloads/codex-0.166.0-UserPromptSubmit.captured.json`. |
| codex | SessionEnd | token counts | absent | Live capture adds only `reason`. [Hooks](https://learn.chatgpt.com/docs/hooks). `payloads/codex-0.166.0-SessionEnd.captured.json`. |
| codex | PostToolUse | token counts | absent | Official extra fields are tool name, id, and input. No usage field. Not captured: the 401 happened before a tool call. [Hooks](https://learn.chatgpt.com/docs/hooks). |
| codex | SubagentStop | token counts | absent | Official extras are `turn_id`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message`. No usage field. [Hooks](https://learn.chatgpt.com/docs/hooks). |
| codex | Stop | token counts | absent | Official extras are `turn_id`, `stop_hook_active`, `last_assistant_message`. No usage field. Not captured: the model request returned 401 before Stop. [Hooks](https://learn.chatgpt.com/docs/hooks). |
| codex | PreCompact | token counts | absent | Official extras are `turn_id` and `trigger` only. Rizz does not install this event. Not captured. [Hooks](https://learn.chatgpt.com/docs/hooks). |
| claude | SessionStart | `context_tokens` | present | Only when `source` is `resume` or `fork` and the transcript already has a response, Claude Code v2.1.251+. Also `estimated_cache_write_usd`. [Hooks reference](https://code.claude.com/docs/en/hooks). Not captured: our run was `source: startup`. |
| claude | SessionStart | `context_tokens` on startup | absent | Live startup payload has `source` and no token field. `payloads/claude-code-2.1.314-SessionStart.captured.json`. |
| claude | UserPromptSubmit | token counts | absent | Live payload is the prompt plus common fields. `payloads/claude-code-2.1.314-UserPromptSubmit.captured.json`. [Hooks reference](https://code.claude.com/docs/en/hooks). |
| claude | SessionEnd | token counts | absent | Live payload adds `reason` only. `payloads/claude-code-2.1.314-SessionEnd.captured.json`. [Hooks reference](https://code.claude.com/docs/en/hooks). |
| claude | Stop | token counts | absent | Published Stop input adds `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. No usage object. Not captured: login failed before a model turn. [Hooks reference](https://code.claude.com/docs/en/hooks). A feature request says the same thing: [anthropics/claude-code#80446](https://github.com/anthropics/claude-code/issues/80446). |
| claude | PostToolUse | `tool_response.usage` | present | When `tool_name` is `Agent` and the subagent finished in the foreground. `usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. `totalTokens` is the final request only. [Hooks reference](https://code.claude.com/docs/en/hooks), Agent tool response. Not captured. |
| claude | PostToolUse | `tool_response.usage` for other tools | absent | The same page limits those counters to a foreground Agent result. Background Agent results (`async_launched`) have no usage fields. |
| claude | PreModelSwitch | `context_tokens` | present | Combined tokens the next request would re-send. Also `estimated_cache_write_usd`. Rizz does not install this event. [Hooks reference](https://code.claude.com/docs/en/hooks). Not captured. |
| claude | PreCompact | token counts | absent | Published input adds `trigger` and `custom_instructions` only. [Hooks reference](https://code.claude.com/docs/en/hooks). Not captured. |

## What the observer stores

`usageFields` in `packages/brain/src/observe/model.ts` (lines 114–140) copies a number into the journal only when it sees:

| Journal field | Accepted payload names |
| --- | --- |
| `inputTokens` | `usage.input_tokens`, `usage.inputTokens`, or the same names on the payload itself |
| `outputTokens` | `output_tokens`, `outputTokens` |
| `cacheRead` | `cache_read_input_tokens`, `cached_input_tokens` |
| `cacheWrite` | `cache_creation_input_tokens` |
| `contextTokens` | `context_tokens` on the payload (not nested under `usage`) |

It does not read Cursor's `cache_read_tokens` or `cache_write_tokens` names from the staff reply. A Cursor stop payload that uses only those names would keep `output_tokens` and `input_tokens` (those names match) and drop the two cache counts. Codex hook payloads, on the evidence above, have nothing for this function to copy. Claude foreground Agent `tool_response.usage` is nested under `tool_response`, which this function does not look at, so those counts are not stored either.
