# Observer progress

Rizz records the host coding agent. It does not drive that agent. Each phase below was checked
with `pnpm exec tsc -b` and the observer tests in `packages/brain/src/observe/observe.test.ts`.

## Phase 1 — User-level agent bridges

**Before:** Rizz on `main` scanned a repo into an in-repo JSON brain and could review, explain, and
chat. It had no MCP tools, no out-of-repo project store, and no skill install for Codex or Claude.

**After:** `feature/user-agent-bridges` is merged into this branch. `rizz prepare` keeps a
project store outside the repo. `rizz mcp` exposes `get_task_brief`, `record_checkpoint`, and
`create_handoff`. `rizz agents configure` installs skills under `.codex`, `.claude`, `.agents`,
and `.copilot`.

**Demo:** `rizz agents detect --json` lists those hosts without writing skills. The command is
covered by `user-level agent bridges` in `packages/brain/src/agent-bridges.test.ts`.

## Phase 2 — Append-only brain, hooks, and local page

**Before:** The bridges store had product, loop, and handoff files, but nothing watched Cursor,
Codex, or Claude Code. Threads were only recorded when an agent called MCP on purpose.

**After:** `rizz init` creates `<rizz-home>/projects/<id>/observe/` for the current project path.
`BRAIN.md` is a rewritten index of at most 200 lines. `journal/YYYY-MM.md` is append-only.
`rizz hook <tool> <event>` always exits 0 and appends to a spool. `rizz serve` folds the spool,
updates the ledger, writes a handoff on stop, and serves a stateless page on `127.0.0.1`.
`rizz summary` prints the thread count and only the inbox items waiting on the owner.

**Demo:**

```text
$ RIZZ_HOME=/tmp/rizz-obs-home RIZZ_HOOK_HOME=/tmp/rizz-obs-hooks \
    node packages/cli/dist/index.js init --host cursor --no-serve --no-open
rizz brain ready
  brain: /tmp/rizz-obs-home/projects/95e987201e4d7526813aaaf3/observe/BRAIN.md
  hooks: cursor

$ RIZZ_HOME=/tmp/rizz-obs-home node packages/cli/dist/index.js hook cursor beforeSubmitPrompt
{"continue":true}

$ RIZZ_HOME=/tmp/rizz-obs-home node packages/cli/dist/index.js hook cursor stop
{}

$ RIZZ_HOME=/tmp/rizz-obs-home node packages/cli/dist/index.js fold
rizz folded 2 event(s)

$ RIZZ_HOME=/tmp/rizz-obs-home node packages/cli/dist/index.js summary
1 thread(s) observed.
Needs the owner:
- Should health require auth? (cursor-conv-1)

$ RIZZ_HOME=/tmp/rizz-obs-home node packages/cli/dist/index.js tokens
reported: 0 in / 0 out
cache: 0 read / 0 write
context: 0
unreported runs: 1
cursor-conv-1: 0 in / 0 out / 1 unreported
```

The prompt hook was `beforeSubmitPrompt` with `conversation_id` `conv-1` and the text
`Owner decision: Should health require auth?`. The stop hook sent `status: completed`.
Cursor did not report turn tokens, so the ledger counts one unreported run.

The same path is what `fake Cursor session > records hooks into the brain, ledger, handoff, and local page` asserts, including the HTML page and a 401 when the page token is missing.
