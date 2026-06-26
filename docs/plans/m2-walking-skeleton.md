# M2 — Walking skeleton (plan)

**Exit criterion (§13):** `rizz` installs in one command, launches a TUI, runs an empty loop
against the Claude subscription via `/login`.

**Honest scoping (anti-overclaim):** the real subscription OAuth (`/login`) + live model calls are
**M3** (provider layer). M2 delivers the end-to-end *skeleton*: the loop, a TUI shell per the UI/UX
spec, and one-command install — with a **stub provider** standing in for the model. The provider
boundary is shaped now so M3 swaps in the real Claude adapter with no loop/TUI changes.

## Slice

- **`@valoir/rizz-providers` (service layer):** `Provider` interface (`complete(req) → Result<…>`),
  message/request/result types, and a `StubProvider` (no network, echoes a demo reply). Real Claude
  subscription adapter = M3.
- **`@valoir/rizz-core` (orchestration):** `runTurn` — the loop (model-call → tool-dispatch → tool-result
  → repeat) with interrupt (`AbortSignal` → `INTERRUPTED`), budget (turns/tokens cap →
  `BUDGET_EXCEEDED`), and an iteration cap. No tools registered yet (empty loop); structured so M3
  adds tool dispatch. In-memory `Session`.
- **`@valoir/rizz-tui`:** zero-dependency ANSI + `readline` TUI (decision D-015) — valoir theme, header,
  empty-state invitation, status bar, honest loop display, Ctrl+C interrupt, `/help` + `/exit`.
  Pure render functions are unit-tested; the interactive loop is thin.
- **`@valoir/rizz`:** `rizz` (no args) → TTY launches the TUI; non-TTY reads stdin and runs one turn
  (print-mode seed). `--version`/`--help` unchanged.
- **Install:** `scripts/install.sh` — `pnpm install && pnpm build` then link `rizz` onto PATH. One
  command. Documented in README.

## Constraints honored

- **Lightweight-first:** zero new runtime dependencies → footprint budget stays green (D-015, §2).
- **Service-layer split (D-005):** mechanics in `providers`, orchestration in `core`/`cli`.
- **No hardcoded public name (D-010):** header uses the internal "rizz · by Valoir" placeholder.
- **Cross-platform (D-008):** no shell-specific code; CI matrix must stay green on all three OSes.

## Dev loop

worktree `feature/m2-walking-skeleton` → build → `pnpm check` green → code-simplifier pass → PR to
`develop` → local `check-pr` + `review-loop` gate → merge.
