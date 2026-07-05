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

1. Calibrate Architecture Reasoning so capped large-repo UAT scores service-to-flow causality,
   impact maps, cross-component relationship evidence, what-breaks claims, and confidence debt
   separately.
2. Scorecard reporting after each UAT run: planned score, actual repo capability score, and
   remaining distance to 100.
3. Use bounded UAT on complex repos such as `github/docs` and `vercel/next.js` to choose the next
   weakest capability instead of guessing.
4. Full local gate: `pnpm check`, `pnpm pack:check`, `git diff --check`.

The current slice sharpens Architecture Reasoning for script-derived flows. rizz now separates
missing local evidence from local static evidence that still needs runtime verification, so
manifest-backed command targets no longer inflate the "needs local evidence" queue. After
calibration, the 120-file large-repo UAT matrix moved Architecture Reasoning from 83/100 to 84/100:
`github/docs` Architecture moved from 78/100 to 79/100, and `vercel/next.js` moved from 88/100 to
89/100. The next weakest repo-derived area remains Architecture Reasoning, specifically component
boundary evidence and component-local tests/configs rather than blanket script-flow evidence debt.

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

## Latest 120-File UAT Actuals

Run: `scripts/uat-large-repos.mjs --max-files 120 --timeout-ms 90000`

| Capability | Matrix score | Remaining | Previous matrix score | Movement |
| --- | ---: | ---: | ---: | ---: |
| Flow Understanding | 91/100 | 10 | 87/100 | +4 |
| Architecture Reasoning | 84/100 | 16 | 83/100 | +1 |
| Evidence Quality scoring | 100/100 | 0 | 100/100 | 0 |
| Mission Control UX | 100/100 | 0 | 100/100 | 0 |
| PI-Bench seed/task format | 97/100 | 3 | 97/100 | 0 |
| Incremental Understanding metrics | 88/100 | 12 | 88/100 | 0 |
| Review Intelligence with true blast radius | 91/100 | 9 | 90/100 | +1 |
| `rizz ask` | 92/100 | 8 | 92/100 | 0 |

Repo detail:

| Repo | Architecture score | Remaining | Local evidence gap flows | Static runtime verification flows | Weakest capability |
| --- | ---: | ---: | ---: | ---: | --- |
| `github/docs` | 79/100 | 21 | 0 | 113 | Architecture Reasoning, 79/100 |
| `vercel/next.js` | 89/100 | 11 | 0 | 101 | Incremental Understanding metrics, 88/100 |

Precision notes:

- `github/docs` no longer reports `113 flow(s) need local evidence`; it reports 113 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows.
- `vercel/next.js` no longer reports `101 flow(s) need local evidence`; it reports 101 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows.
- Runtime verification remains explicit in `flow_evidence_precision`; local static evidence does not
  upgrade these script-derived flows to verified architecture confidence.
