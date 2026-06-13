# rizz

> The lightest, most connectable coding agent harness. **Single-agent and minimal by default**
> (Pi-class front door); **Hermes-class power on demand** behind an opt-in `/workspace` switch.

rizz is a CLI-installable coding agent loop — model-call → tool-dispatch → tool-result → repeat,
with interrupt, compression, budget, and fallback — built to three principles:

1. **Extremely lightweight.** Minimal dependencies, fast cold start, small footprint. Enforced by a
   CI footprint budget, not by good intentions.
2. **Provider-agnostic.** Subscription `/login` *or* BYOK *or* cloud creds across a curated provider
   catalog. No model lock-in.
3. **A hub, not an island.** Callable by any tool (print/JSON, RPC, SDK; MCP/ACP) and connects *to*
   Cursor / Claude / Codex rather than replacing them.

## Status

Early build. Milestones (brief §13):

- **M0 — repo + standards** ✅ monorepo, CI (lint · type-check · test · eval · footprint), house style.
- **M2 — walking skeleton** — one-command install, TUI, empty loop on the Claude subscription.
- **M3 — single-agent core** — the loop + 4 tools (read/write/edit/bash) + provider layer
  (`/login`, `/model`, themes). The Pi-minimal v0.
- **M4 — connectivity** · **M5 — eval harness** · **M6 — `/workspace`** opt-in.

## Layout

```
packages/
  core/        the loop, budget, compression, fallback   (orchestration)
  providers/   model/provider adapters, tool mechanics    (service layer)
  tui/         terminal UI (separable; headless stays light)
  cli/         the `rizz` entrypoint + installer
eval/          the coding-task + footprint/latency suite
docs/
```

## Develop

```bash
pnpm install
pnpm check     # lint + type-check + test + eval + footprint
```

Requires Node ≥ 22 (CI pins 24 LTS) and pnpm. House style and the service-layer architecture rule
live in [CLAUDE.md](./CLAUDE.md); contribution flow in [CONTRIBUTING.md](./CONTRIBUTING.md).

Private during the build; core flips to open (MIT) at v1.
