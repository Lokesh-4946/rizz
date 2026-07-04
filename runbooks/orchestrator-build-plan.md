# Orchestrator Build Plan

rizz is the local Project Intelligence Engine for any coding agent. The build plan should keep that
position sharp: understand the repo, expose evidence, review risk, and give other agents a compact
context contract.

ECC-inspired features are useful when they strengthen that contract without joining the default path.

## Opt-In Expansion Map

| Feature | rizz Usefulness | Default Path |
| --- | --- | --- |
| Session adapters / control-pane snapshot | Import work history and agent state as inspectable evidence. | Opt-in export/import, not always-on orchestration. |
| MCP/tool inventory | Record available tools and risk posture for repo intelligence and review. | Opt-in scan artifact. |
| Worktree lifecycle service | Run isolated experiments and PR loops from a clean branch. | Opt-in workspace mode. |
| Manifest install/state ownership | Install and repair rizz packs without guessing what is owned. | Opt-in pack command. |
| Security scanner | Add secret/risky-pattern evidence to reviews and confidence gates. | Local deterministic scan, no cloud call. |
| Deterministic harness audit | Score whether a repo is ready for agent work. | Local report under `.rizz/research/`. |

## Current Loop

1. Large-repo UAT harness with an explicit repo matrix, per-repo time caps, progress output, and a
   compact JSON report.
2. Traversal priority for manifests, configs, tests, and source before workflow-heavy or
   content-heavy trees when a scan cap is active.
3. Bounded UAT after milestones on complex repos such as `github/docs` and `vercel/next.js`.
4. Full local gate: `pnpm check`, `pnpm pack:check`, `git diff --check`.

The current slice makes capped scans useful on large repos and turns long-running UAT into a
deterministic report instead of an opaque hang. The next useful slice is analyzer subphase progress
and cost calibration so large scans can show which research/artifact pass is taking time after
traversal completes.
