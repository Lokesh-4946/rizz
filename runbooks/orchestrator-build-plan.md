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

The current slice makes package-script flows causally useful under capped scans. Script commands now
produce manifest-backed command-target steps when their target path is named in `package.json` but
falls outside the scan cap, while scanned shell scripts are treated as source handlers. Quoted
compound commands are rejected as targets so rizz does not invent fake file paths. After
calibration, the 120-file large-repo UAT matrix moved Flow Understanding from 87/100 to 91/100:
`github/docs` Flow moved from 85/100 to 90/100, and `vercel/next.js` moved from 88/100 to 91/100.
The next weakest repo-derived area is Architecture Reasoning, specifically reducing low-confidence
script architecture gaps without over-claiming runtime verification.

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
| Architecture Reasoning | 83/100 | 17 | 83/100 | 0 |
| Evidence Quality scoring | 100/100 | 0 | 100/100 | 0 |
| Mission Control UX | 100/100 | 0 | 100/100 | 0 |
| PI-Bench seed/task format | 97/100 | 3 | 97/100 | 0 |
| Incremental Understanding metrics | 88/100 | 12 | 88/100 | 0 |
| Review Intelligence with true blast radius | 91/100 | 9 | 90/100 | +1 |
| `rizz ask` | 92/100 | 8 | 92/100 | 0 |

Repo detail:

| Repo | Flow score | Remaining | Inventory-only scripts | Command-target script flows | Weakest capability |
| --- | ---: | ---: | ---: | ---: | --- |
| `github/docs` | 90/100 | 10 | 4 | 101 | Architecture Reasoning, 78/100 |
| `vercel/next.js` | 91/100 | 9 | 17 | 57 | Architecture Reasoning, 88/100 |

Precision notes:

- `github/docs` inventory-only package-script flows dropped from 82 to 4 under the 120-file cap.
- `vercel/next.js` inventory-only package-script flows dropped from 26 to 17 under the 120-file cap.
- Manifest-backed command-target steps are evidence-backed by the package script line and do not
  pretend an out-of-cap source file was scanned.
