# Headless interface (job #3 — drive rizz from other tools)

rizz is a callable hub, not an island (§12). Two headless surfaces let a script, CI step, editor, or a
bridge (e.g. the deferred Telegram bot, D-036) drive it without the TUI. Both **reuse the agent loop +
services** — same tools, same budget, same bash approve/deny gate — they do not fork it.

Connect a model the usual way (BYOK, D-033): set `ANTHROPIC_API_KEY` in the environment, or `/login`
once in the TUI to store a key in the keychain. With no key, headless mode runs against the demo stub.

## 1. One-shot JSON — `rizz --json`

A single turn in on stdin, a structured JSON object out on stdout (one line). Human notices (e.g. a
keychain warning) go to **stderr**, so **stdout stays pure JSON**.

```sh
echo "summarize src/loop.ts" | rizz --json
echo "..." | rizz --json --profile deep      # selection flags compose
```

**Result shape:**

```jsonc
{
  "ok": true,
  "reply": "…the assistant's final text…",
  "model": "claude-opus-4-8",          // omitted in demo mode
  "toolCalls": [                          // omitted when none ran
    { "display": "read · src/loop.ts · 120 lines", "ok": true }
  ],
  "usage": { "tokens": 1840 },
  "costUsd": 0,                           // 0 on the subscription/demo path
  "stopReason": "final"                  // final | backstop | interrupted
}
```

On failure, **never a stack** — a stable `RizzError` code:

```jsonc
{ "ok": false, "error": { "code": "PROVIDER_AUTH", "message": "Anthropic API error 401" } }
```

Exit codes: `0` ok, `1` turn failed (`ok:false`), `2` bad invocation (e.g. empty input).

**Safety:** there is no channel to ask, so destructive/networked `bash` is **denied** automatically
(it appears in `toolCalls` as `… · denied · …`). Read-only tools run.

## 2. RPC — `rizz --rpc`

A long-lived **line-delimited JSON** protocol over stdin/stdout. The parent process sends requests and
receives responses + streamed event notifications. One request/response per line.

### Requests (client → rizz)

| method | params | response `result` |
|---|---|---|
| `session.start` | — | `{ sessionId }` (string, or `null` if not persisted) |
| `session.resume` | `{ sessionId }` | `{ sessionId, messages }` (count rehydrated) |
| `turn` | `{ input }` | `{ reply, stopReason, usage, costUsd }` (after the turn completes) |
| `approve` | `{ requestId, approved, editedCommand? }` | `{ ok: true }` |

Every request carries an `id`; the matching response echoes it as `{ id, result }` or
`{ id, error: { code, message } }`.

### Events (rizz → client, while a turn runs)

Emitted as `{ "method": "event", "params": { "type": …, … } }`:

- `chunk` — `{ delta }` streamed assistant text (when the provider streams)
- `assistant` — `{ content }` the assistant message
- `tool` — `{ display, ok }` a tool call's compact line + success
- `fallback` / `compacted` / `notice` — `{ note | message }`
- `approval-denied` — `{ command }` a denied command (after the gate)

### The approval gate is a protocol message (never bypassed)

When the model asks to run a **destructive or networked** `bash` command, rizz emits:

```jsonc
{ "method": "approval", "params": { "requestId": "2:1", "command": "rm -rf build", "kind": "destructive", "reason": "…" } }
```

The turn **parks** until the client answers with an `approve` request quoting that `requestId`:

```jsonc
{ "id": 3, "method": "approve", "params": { "requestId": "2:1", "approved": false } }
```

`approved: true` runs it (optionally `editedCommand` to substitute); `approved: false` denies it and the
denial is reported back to the model. **rizz never auto-approves remotely** — a bridge must relay this to
a human (e.g. inline buttons) and must not blanket-approve.

### Example session

```jsonc
→ { "id": 1, "method": "session.start" }
← { "id": 1, "result": { "sessionId": "abc123" } }
→ { "id": 2, "method": "turn", "params": { "input": "delete the build dir" } }
← { "method": "event", "params": { "type": "tool", "display": "bash · …", "ok": true } }
← { "method": "approval", "params": { "requestId": "2:1", "command": "rm -rf build", "kind": "destructive", "reason": "…" } }
→ { "id": 3, "method": "approve", "params": { "requestId": "2:1", "approved": false } }
← { "id": 3, "result": { "ok": true } }
← { "method": "event", "params": { "type": "approval-denied", "command": "rm -rf build" } }
← { "id": 2, "result": { "reply": "Skipped — you denied it.", "stopReason": "final", "usage": { "tokens": 120 }, "costUsd": 0 } }
```

## Notes

- **Core-light:** both modes are orchestration in `core`/`cli` over the existing loop — no new
  dependencies, JSON only. They count toward the 200KB core budget (D-039).
- **Sessions** persist to `~/.rizz/sessions` (node:sqlite, JSONL fallback) when the store is available,
  so `session.resume` works across processes. One active session per RPC process in this version.
- This is the surface a future Telegram/CI/pipeline bridge drives (D-036) — the bridge stays external;
  the core never imports it.
