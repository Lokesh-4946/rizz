# Handoff — BYOK OpenAI-compatible adapter (M4, D-044)

**PR:** [rizz#12](https://github.com/Lokesh-4946/rizz/pull/12) → `develop` · **Branch:** `feature/m4-openai-adapter`
**Decisions:** D-043 (decision log is now a tracked file), D-044 (this adapter)

## What landed

A single BYOK adapter for any **OpenAI-compatible** endpoint (OpenAI, OpenRouter, Ollama, custom),
selected by a **provider-factory** on `model.provider`. The agent loop is unchanged; services stay
pure (ADR-001/D-024); selection + credential resolution are orchestration in `core`.

| Area | File | Note |
|---|---|---|
| Adapter | `packages/providers/src/providers/openai.ts` | stream + non-stream, tool mapping, status→RizzError, redaction, keyless |
| Shared SSE | `packages/providers/src/providers/sse.ts` | extracted; Anthropic adapter now reuses it |
| Shared util | `packages/providers/src/providers/util.ts` | `codeForStatus` + `redact`, shared by both adapters |
| Factory + creds | `packages/core/src/bootstrap.ts` | `createProviderFor`, `selectModel`, `resolveCredential`, `envVarFor` |
| Registry | `packages/providers/src/model/registry.ts` | `ModelInfo` += `baseUrl`, `keyless`; built-in carries OpenAI |
| On-disk validation | `packages/providers/src/model/registry-store.ts` | optional `baseUrl`/`keyless` type checks |
| Docs | `runbooks/install.md` | "Connect a model" → OpenAI/OpenRouter/Ollama/custom |

## Key design decisions (D-044)

- **Credential by convention:** the key is `<PROVIDER>_API_KEY` (env override → keychain account =
  provider id). So `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MYCORP_API_KEY` all work with zero
  per-provider plumbing, and **no key is ever stored in the registry — only referenced**.
- **Keyless local:** a model with `keyless: true` (Ollama) connects with no key and sends no
  `Authorization` header.
- **Built-in vs on-disk split:** OpenAI ships in `DEFAULT_REGISTRY`; OpenRouter/Ollama/custom go in
  `~/.rizz/models.json`. This keeps local/free endpoints out of the **opt-in capability auto-router**
  by default, so `--capability code --preferCheap` won't silently route to a local server that may not
  be running.
- **Why one adapter:** OpenAI/OpenRouter/Ollama/custom differ only by `baseUrl`; the Chat Completions
  wire is identical. Forking per provider would be drift waiting to happen.

## Tests

`packages/providers/src/providers/openai.test.ts` (adapter mapping, stream, error codes, redaction,
keyless) and new cases in `packages/core/src/bootstrap.test.ts` (factory selection by provider:
OpenAI → `/chat/completions` + bearer; OpenRouter → its base URL + `OPENROUTER_API_KEY`; keyless
Ollama → no auth header; Anthropic → `/v1/messages`). Full `pnpm check` green: 227 tests, lint,
typecheck, eval, footprint **158KB/200KB**, cold start 49ms.

## Follow-ups (not in this PR)

1. **`local` profile** still points at a placeholder model id and stays an honest stub. Wire it to a
   concrete local model id (e.g. `llama3.1`) once a default local entry is chosen — update
   `profiles.ts` + the `profile 'local'` test in `bootstrap.test.ts`.
2. **Multi-provider `/login`** — entering a non-Anthropic key interactively in the TUI. Today `/login`
   persists to the Anthropic keychain account; generalize to prompt for / store per-provider keys.
3. **Profile knobs** (thinking/temperature) still aren't applied by either adapter — pre-existing
   (surfaced as a notice), tracked separately.

## State of the dev loop

- Build → simplify (no clarity changes needed) → PR #12 opened.
- **greploop blocked:** Greptile returns "reached the 50-review limit for trial accounts" — same
  external quota that blocked #11. No confidence score obtainable; needs a plan upgrade or a human
  sign-off per D-005 ("5/5 *or* a human signs off the remainder").

## Next M4 slice

One **MCP server as an opt-in package** — tracks its own size; core budget stays 200KB (D-039).
It must not be imported by any core package (D-001), so it never loads on the default cold path.
