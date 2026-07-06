# Orchestrator Build Plan

rizz is the local Project Intelligence Engine for any coding agent. The build plan should keep that
position sharp: understand the repo, expose evidence, review risk, and give other agents a compact
context contract.

ECC-inspired features are useful when they strengthen that contract without joining the default path.

## Human-Agent Loop

rizz is most useful when a human keeps their preferred coding agent and uses rizz as the local
evidence contract around that agent:

1. Human intent.
2. rizz mission contract, project intelligence, and inspect-first context.
3. Coding agent implementation.
4. rizz review.
5. rizz correction packet.
6. Coding agent repair.
7. rizz verification.
8. Human approval.

The product should optimize this loop without turning rizz into a heavy default orchestrator. rizz
must distinguish static understanding from runtime verification, recommend targeted checks, and only
upgrade confidence when evidence exists.

Current loop readiness:

| Stage | Readiness | Remaining | Notes |
| --- | ---: | ---: | --- |
| Human intent | 75/100 | 25 | Intent can enter through CLI/review/explain flows, but mission-contract capture is still lightweight. |
| rizz mission contract, project intelligence, and inspect-first context | 90/100 | 10 | Project intelligence, Mission Control, confidence queues, security/tool inventory, unified repair packets, and UAT artifacts are strong; mission-contract packaging can be sharper. |
| Coding agent implementation | 73/100 | 27 | rizz can now hand agents one deterministic repair packet, but session adapters and apply/repair loops remain opt-in/future work. |
| rizz review | 91/100 | 9 | Review Intelligence has blast-radius evidence, affected flows/tests/configs, and deterministic review artifacts. |
| rizz correction packet | 89/100 | 11 | Unified `agent_repair_packets` now combine architecture correction, evidence quality, review blast radius, verification guidance, and component-local duplicate assumption provenance. |
| Coding agent repair | 77/100 | 23 | Repair instructions are packetized and less duplicative for agents, but agent-specific apply/repair loops are not yet first-class. |
| rizz verification | 85/100 | 15 | Verification evidence and runtime-honesty rules feed repair packets; targeted proof loops need stronger UX and scoring. |
| Human approval | 70/100 | 30 | Reports support approval, but explicit approval packets and signoff state are still thin. |

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

The current slice improves Architecture Reasoning packet precision. rizz still writes
`.rizz/research/agent_repair_packets.json` as the single prioritized inspect/repair/verify packet
list, but component-local correction packets now fold duplicate architecture assumptions and
low-confidence component areas into `related_packet_ids`. The 120-file large-repo UAT matrix stayed
at Architecture Reasoning 84/100, but `github/docs` dropped from 12 to 10 repair packets and from 3
to 1 architecture packet while preserving the folded assumption provenance. The next weakest
repo-derived area remains Architecture Reasoning, specifically turning component-local packet
evidence into stronger causal what-breaks explanations without over-claiming runtime verification.

## Capability Scorecard

These are the orchestrator baseline scores for planned work. UAT reports also include actual
repo-derived scores from `.rizz/research/understanding_score.json`.

| Planned item | Current | Remaining | Next improvement |
| --- | ---: | ---: | --- |
| Flow Understanding | 91/100 | 10 | Deepen route, service, and journey reconstruction. |
| Architecture Reasoning | 84/100 | 16 | Reduce weak component boundary assumptions and direct-evidence gaps. |
| Evidence Quality scoring | 100/100 | 0 | Preserve actionability while keeping packet output compact. |
| Mission Control UX | 100/100 | 0 | Keep unified packet drilldowns visible without clutter. |
| PI-Bench seed/task format | 97/100 | 3 | Broaden deterministic task coverage and UAT fixtures. |
| Incremental Understanding metrics | 88/100 | 12 | Improve repeated-scan reuse and stale-surface explanations. |
| Review Intelligence with true blast radius | 91/100 | 9 | Tie changed files to user-visible failures with stronger causality. |
| `rizz ask` | 92/100 | 8 | Keep gated until packet/verification confidence is stronger. |

## Latest 120-File UAT Actuals

Run: `scripts/uat-large-repos.mjs --max-files 120 --timeout-ms 90000`
Report: `.rizz/uat/repair-packet-precision-120-report.json`

| Capability | Matrix score | Remaining | Previous matrix score | Movement |
| --- | ---: | ---: | ---: | ---: |
| Flow Understanding | 91/100 | 10 | 91/100 | 0 |
| Architecture Reasoning | 84/100 | 16 | 84/100 | 0 |
| Evidence Quality scoring | 100/100 | 0 | 100/100 | 0 |
| Mission Control UX | 100/100 | 0 | 100/100 | 0 |
| PI-Bench seed/task format | 97/100 | 3 | 97/100 | 0 |
| Incremental Understanding metrics | 88/100 | 12 | 88/100 | 0 |
| Review Intelligence with true blast radius | 91/100 | 9 | 91/100 | 0 |
| `rizz ask` | 92/100 | 8 | 92/100 | 0 |

Repo detail:

| Repo | Architecture score | Remaining | Local evidence gap flows | Static runtime verification flows | Weakest capability |
| --- | ---: | ---: | ---: | ---: | --- |
| `github/docs` | 79/100 | 21 | 0 | 113 | Architecture Reasoning, 79/100 |
| `vercel/next.js` | 89/100 | 11 | 0 | 100 | Incremental Understanding metrics, 88/100 |

Precision notes:

- `github/docs` no longer reports `113 flow(s) need local evidence`; it reports 113 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows. `component:src` is verified from
  15 direct entrypoints, 44 local tests, 8 local configs, and 8 read-first files; `component:config`
  remains inferred with 8 read-first files and now gets a priority-1 correction packet for missing
  component-local config/test/entrypoint/flow evidence.
- `vercel/next.js` no longer reports `101 flow(s) need local evidence`; it reports 101 weak flows as
  static runtime-verification debt with 0 local-evidence gap flows. `component:scripts` is verified
  from 52 direct entrypoints, 2 local configs, and 8 read-first files, while now getting a priority-1
  correction packet for 0 local tests; `component:test` is verified from 3 direct entrypoints, 32
  local tests, 4 local configs, and 8 read-first files.
- Runtime verification remains explicit in `flow_evidence_precision`; local static evidence does not
  upgrade script-derived flows to verified architecture confidence, and correction packets do not
  claim repairs were performed.
- Unified repair packets preserve provenance instead of collapsing all guidance into one opaque
  instruction: `github/docs` produced 10 packets with 1 architecture packet, 2 evidence-quality, 6
  security, and 1 tool packet; its P1 `component:config` correction packet folded
  `assumption:component:config:boundary` and the component low-confidence area into
  `related_packet_ids`. `vercel/next.js` produced 12 packets with 1 architecture, 9
  evidence-quality, 1 security, and 1 tool packet; `component:scripts` remains P1. Review-time
  packets add `review_blast_radius` and `verification` sources after `rizz review`.
