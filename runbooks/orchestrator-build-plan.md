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

1. Calibrate first-scan Incremental Understanding so baseline capture is scored separately from
   repeated-scan reuse.
2. Scorecard reporting after each UAT run: planned score, actual repo capability score, and
   remaining distance to 100.
3. Use bounded UAT on complex repos such as `github/docs` and `vercel/next.js` to choose the next
   weakest capability instead of guessing.
4. Full local gate: `pnpm check`, `pnpm pack:check`, `git diff --check`.

The current slice keeps raw first-scan reuse metrics honest while scoring baseline capture fairly.
After calibration, the 120-file large-repo UAT matrix moved Incremental Understanding metrics from
45/100 to 88/100, leaving Flow Understanding and Architecture Reasoning as the next weakest actual
repo-derived areas.

## Capability Scorecard

These are the orchestrator baseline scores for planned work. UAT reports also include actual
repo-derived scores from `.rizz/research/understanding_score.json`.

| Planned item | Baseline | Remaining | Next improvement |
| --- | ---: | ---: | --- |
| Flow Understanding | 86/100 | 14 | Deepen route, service, and journey reconstruction. |
| Architecture Reasoning | 87/100 | 13 | Calibrate confidence and what-breaks claims. |
| Evidence Quality scoring | 88/100 | 12 | Make weak, stale, and low-confidence evidence easier to inspect. |
| Mission Control UX | 88/100 | 12 | Expose score, queue, and drilldown movement in the portal. |
| PI-Bench seed/task format | 86/100 | 14 | Broaden deterministic task coverage and UAT fixtures. |
| Incremental Understanding metrics | 88/100 | 12 | Improve repeated-scan reuse and stale-surface explanations. |
| Review Intelligence with true blast radius | 88/100 | 12 | Tie changed files to user-visible failures with stronger causality. |
| `rizz ask` | 0/100 | 100 | Keep gated until foundation scores justify broad answers. |
