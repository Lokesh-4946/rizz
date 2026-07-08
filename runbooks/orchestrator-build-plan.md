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
| Human intent | 76/100 | 24 | Intent can enter through CLI/review/explain flows, and review can now warn when dirty local work may distort the requested task scope; capture UX is still lightweight. |
| rizz mission contract, project intelligence, and inspect-first context | 98/100 | 2 | Project intelligence, Mission Control, confidence queues, file-level explain, DBMS schema/model entities, security/tool inventory, unified repair packets, UAT artifacts, review-time mission-contract comparison, mission-contract normalization, and lexical unrelated-work hints are strong; explicit mission capture UX can still be sharper. |
| Coding agent implementation | 73/100 | 27 | rizz can now hand agents one deterministic repair packet, but session adapters and apply/repair loops remain opt-in/future work. |
| rizz review | 99/100 | 1 | Review Intelligence has blast-radius evidence, affected flows/tests/configs, deterministic review artifacts, and review-governance checks for Git hygiene, branch freshness, generated noise, normalized duplicate code, mission-contract drift, semantic unrelated-work hints, and dirty-tree/branch-diff mixed-basis reporting. |
| rizz correction packet | 90/100 | 10 | Unified `agent_repair_packets` now combine architecture correction, evidence quality, review blast radius, agent verification-plan actions, and component-local duplicate assumption provenance. |
| Coding agent repair | 77/100 | 23 | Repair instructions are packetized and less duplicative for agents, but agent-specific apply/repair loops are not yet first-class. |
| rizz verification | 95/100 | 5 | rizz now scores proof, missing evidence, distinct human approval packet state, and a safe signoff handoff that must be ingested by review. |
| Human approval | 86/100 | 14 | Reports separate agent evidence readiness from human signoff, and `rizz approve signoff` records explicit human decisions with audit history once review is ready. |

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

The current slice hardens DBMS-style repo usefulness. rizz now detects nested lockfile package
managers, promotes SQL tables and Mongoose models into `database/table` entities, narrows
route/controller review blast radius with route-local token matching, and filters no-op/failing test
scripts out of required verification suggestions.

## Capability Scorecard

These are the orchestrator baseline scores for planned work. UAT reports also include actual
repo-derived scores from `.rizz/research/understanding_score.json`.

| Planned item | Current | Remaining | Next improvement |
| --- | ---: | ---: | --- |
| Flow Understanding | 92/100 | 8 | Deepen route, service, and journey reconstruction on larger DBMS/MVC repos. |
| Architecture Reasoning | 85/100 | 15 | Reduce weak component boundary assumptions and add richer DB relationship evidence. |
| Evidence Quality scoring | 100/100 | 0 | Preserve actionability while keeping packet output compact. |
| Mission Control UX | 100/100 | 0 | Keep unified packet drilldowns visible without clutter. |
| PI-Bench seed/task format | 98/100 | 2 | Broaden deterministic task coverage and UAT fixtures. |
| Incremental Understanding metrics | 88/100 | 12 | Improve repeated-scan reuse and stale-surface explanations. |
| Review Intelligence with true blast radius | 99/100 | 1 | Add richer branch/PR provider context and keep reducing false positives in unrelated-work hints. |
| Verification Plan + Evidence Ingest | 95/100 | 5 | Reuse approval/signoff history across repeated agent repair loops and make review ingestion more automatic. |
| `rizz ask` | 93/100 | 7 | Keep gated until packet/verification confidence is stronger and file-level answers are less generic. |

## Latest Baton Result

Run: `feature/dbms-usefulness-hardening`, local gate on the rizz repo.

| Check | Result |
| --- | ---: |
| Focused DBMS hardening tests | 2/2 passed |
| Focused brain regression file | 68/68 passed |
| Focused formatting check | Passed |
| Typecheck | Passed |
| Full unit suite | 369/369 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 10/10 passed |
| Install-local smoke | 5/5 passed |
| Pack/public check | Passed |
| Footprint | cold start 48ms / 250ms, core 198KB / 200KB |
| Full `pnpm check` | Passed |
| rizz self-review | Investigate, 0 critical findings |

Current verdict: rizz is less misleading on DBMS-style repos. Agents should now get real
SQL/Mongoose schema surfaces, nested npm workspaces no longer look package-manager unknown, route
controller changes produce narrower affected-flow lists, and unusable `npm test` placeholders are
not presented as required proof. Remaining work is richer schema relationships and larger public
repo UAT after merge.

## Latest DBMS-Like UAT Agent Results

Run: QA sidecar on public DBMS-style repos, using fresh rizz `develop` and temp target clones.

| Repo | rizz result | Usefulness | Speedup | Main misses |
| --- | --- | ---: | ---: | --- |
| `iampranavdhar/Library-Management-System-MERN` | 66 files, 2 components, 26 flows, 5 commands, 0 tests; backend/frontend split was useful. | 7/10 | 3-4x orientation speedup | Addressed this baton: nested package manager, Mongoose model entities, route review breadth, unusable test suggestions. Remaining: backend/frontend test ownership precision. |
| `manascb1344/Online-Auction-System` | 69 files, 3 components, 32 flows, 7 commands, 0 tests; client/server/database split and read-first paths were useful. | 6/10 | 2.5-3.5x orientation speedup | Addressed this baton: nested package manager, SQL table entities, controller review breadth, unusable test suggestions. Remaining: generic component wording and deeper SQL relationship parsing. |

UAT verdict: rizz is already useful as an agent cold-start accelerator on DBMS-style repos, mostly
for boundary mapping and read-first orientation. The next DBMS usefulness batons are schema/entity
understanding for SQL/Mongoose, nested lockfile/package-manager detection, route/controller-specific
review blast radius, and filtering no-op or known-failing test scripts out of required verification.

## Latest DBMS UAT Actuals

Run: fresh DBMS brain scan on `/Users/lokesh/Downloads/projects/DBMS`, branch `dev`, using
`feature/file-explain-intelligence`.

| Metric | Result |
| --- | ---: |
| Files scanned | 491 |
| Components | 21 |
| Flows | 178 |
| Commands | 107 |
| Tests | 43 |
| Capability scorecard average | 93/100 |
| Raw understanding score | 89/100 |

Capability detail from `.rizz/research/understanding_score.json`:

| Capability | Actual | Remaining | Notes |
| --- | ---: | ---: | --- |
| Flow Understanding | 95/100 | 5 | 178 high-signal flows; 170 with linked tests. |
| Architecture Reasoning | 79/100 | 21 | Exact consumers, local test gaps, and one service causality path remain weak. |
| Evidence Quality scoring | 98/100 | 2 | Strong evidence coverage with remaining entity/field-specific gaps. |
| Mission Control UX | 100/100 | 0 | Component, flow, architecture, and read-first surfaces are visible. |
| PI-Bench seed/task format | 98/100 | 2 | Needs more real-repo task seeds and deeper ground truth. |
| Incremental Understanding metrics | 88/100 | 12 | First scan baseline; repeated-scan reuse still needs proof. |
| Review Intelligence with true blast radius | 92/100 | 8 | Needs stronger user-visible failure causality. |
| `rizz ask` | 93/100 | 7 | Still blocked until foundations are consistently strong. |

DBMS verdict: the original app-boundary failure is fixed, and file explanations now include
content-derived purpose. The remaining DBMS weakness is not speed; it is precision around
architecture causality, component-local proof, and compact agent entry summaries.

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
