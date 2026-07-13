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
| rizz mission contract, project intelligence, and inspect-first context | 99/100 | 1 | Project intelligence, Mission Control, confidence queues, file-level explain, DBMS schema/model entities including SQLAlchemy/Alembic, security/tool inventory, unified repair packets, UAT artifacts, review-time mission-contract comparison, mission-contract normalization, and lexical unrelated-work hints are strong; explicit mission capture UX can still be sharper. |
| Coding agent implementation | 73/100 | 27 | rizz can now hand agents one deterministic repair packet, but session adapters and apply/repair loops remain opt-in/future work. |
| rizz review | 99/100 | 1 | Review Intelligence has blast-radius evidence, affected flows/tests/configs, deterministic review artifacts, and review-governance checks for Git hygiene, branch freshness, generated noise, normalized duplicate code, mission-contract drift, semantic unrelated-work hints, and dirty-tree/branch-diff mixed-basis reporting. |
| rizz correction packet | 90/100 | 10 | Unified `agent_repair_packets` now combine architecture correction, evidence quality, review blast radius, agent verification-plan actions, and component-local duplicate assumption provenance. |
| Coding agent repair | 78/100 | 22 | Repair instructions are packetized and less duplicative for agents, and backend-scoped verification suggestions reduce agent churn, but agent-specific apply/repair loops are not yet first-class. |
| rizz verification | 100/100 | 0 | rizz scores proof and missing evidence, binds approval to a deterministic review fingerprint, and safely reuses exact-match signoff history across repeated repair reviews. |
| Human approval | 100/100 | 0 | Fingerprint-bound signoff now supports explicit ISO expiry and auditable revocation while preserving agent/human separation. |

## Opt-In Expansion Map

| Feature | rizz Usefulness | Default Path |
| --- | --- | --- |
| Session adapters / control-pane snapshot | Import work history and agent state as inspectable evidence. | Opt-in export/import, not always-on orchestration. |
| MCP/tool inventory | Record available tools and risk posture for repo intelligence and review. | Opt-in scan artifact. |
| Worktree lifecycle service | Run isolated experiments and PR loops from a clean branch. | Opt-in workspace mode. |
| Manifest install/state ownership | Install and repair rizz packs without guessing what is owned. | Opt-in pack command. |
| Security scanner | Add secret/risky-pattern evidence to reviews and confidence gates. | Local deterministic scan, no cloud call. |
| Deterministic harness audit | Score whether a repo is ready for agent work. | Local report under `<project-workspace>/research/`. |
| Audited upstream skill cache | Pin inspected skill content without execution or project enablement. | Shipped foundation: exact revision, digest, license, requirements, explicit approval. |
| Project skill enablement | Select compatible pinned skills without repository installation. | Shipped foundation: project-isolated manifest, cache verification, explicit approval, brief projection. |
| Skill update/removal lifecycle | Preview changes, retain rollback objects, and remove only owned enablement. | Shipped foundation: file-exact preview, approved apply, ownership guard, isolated history. |
| Skill registry integrity | Preserve concurrent global pins and diagnose cache state without destructive cleanup. | Shipped foundation: serialized atomic registry updates, schema validation, read-only doctor, approval-gated quarantine repair. |

## Resource Governance Tracker

Rizz should provide the useful outcomes of Headroom-style context optimization while preserving its
evidence contract. Resource efficiency is subordinate to correctness: source code, exact diffs,
security evidence, failing assertions, and verification proof are never lossy-compressed by default.

| Capability | Status | Acceptance evidence |
| --- | --- | --- |
| Task-scoped context budgets | Shipped foundation | `rizz brief` reports its claim budget, omissions, revision, and stale evidence. |
| Content-addressed context cache | Shipped foundation | Sanitized exact payloads use SHA-256 local objects; duplicate content is verified byte-for-byte. |
| Evidence-preserving tool-output compaction | Shipped foundation | Compacted payloads fall back to the sanitized exact original whenever an evidence gap is reported. |
| Agent dispatch resource leases | Shipped foundation | Opt-in work receives concurrency and expiry limits; capacity is rejected and expired leases are deterministically reclaimed. |
| Shared multi-agent context | Planned after MCP bridges | Agents exchange bounded packets through the isolated project workspace, never by copying whole transcripts or reading another project. |
| Resource-aware scheduling | Planned | Dispatch chooses serial/parallel work from dependency independence, available slots, provider limits, and expected verification cost. |
| Local observability | Shipped foundation | Per work item: input/output bytes, estimated tokens, cache hits, rereads, elapsed time, provider cost, and verification time. |
| Quality fallback | Shipped foundation | An evidence gap serves the exact sanitized original or fails clearly when the object is missing. |
| Agent wrappers | Shipped | Codex, Claude Code, and Copilot receive the same five user-level bridge skills; 20 target files are conflict-safe and byte-verified without repository-local adapters. |

The product target is not maximum compression. It is minimum wasted cognition per accepted,
verified change. A cheaper loop that produces slop, rereads the repository, or weakens evidence is a
resource regression.

## Current Loop

1. Calibrate Architecture Reasoning so capped large-repo UAT scores service-to-flow causality,
   impact maps, cross-component relationship evidence, what-breaks claims, and confidence debt
   separately.
2. Scorecard reporting after each UAT run: planned score, actual repo capability score, and
   remaining distance to 100.
3. Use bounded UAT on complex repos such as `github/docs` and `vercel/next.js` to choose the next
   weakest capability instead of guessing.
4. Full local gate: `pnpm check`, `pnpm pack:check`, `git diff --check`.

The current slice exposes the isolated project OS through a zero-dependency stdio MCP server. Every
supported read has a stable `rizz://` resource or structured tool result; mutations require exact
project, repository revision, and loop sequence matches. Rizz remains the evidence/orchestration
layer and performs no model call.

## Capability Scorecard

These are the orchestrator baseline scores for planned work. UAT reports also include actual
repo-derived scores from `<project-workspace>/research/understanding_score.json`.

| Planned item | Current | Remaining | Next improvement |
| --- | ---: | ---: | --- |
| Flow Understanding | 95/100 | 5 | Broaden real Flask/FastAPI UAT seeds and verify more multi-file Python route/service journeys. |
| Architecture Reasoning | 95/100 | 5 | Reduce weak component boundary assumptions and calibrate causality on more large Python services. |
| Evidence Quality scoring | 100/100 | 0 | Preserve actionability while keeping packet output compact. |
| Mission Control UX | 100/100 | 0 | Keep unified packet drilldowns visible without clutter. |
| PI-Bench seed/task format | 99/100 | 1 | Broaden deterministic task coverage and UAT fixtures. |
| Incremental Understanding metrics | 100/100 | 0 | Preserve exact reuse and relationship-delta accounting across broader real-repo scans. |
| Review Intelligence with true blast radius | 100/100 | 0 | Preserve authored/generated separation and credential precision across broader real-repo reviews. |
| Verification Plan + Evidence Ingest | 100/100 | 0 | Preserve fingerprint-bound evidence and signoff reuse while keeping ingestion deterministic and local. |
| `rizz ask` | 95/100 | 5 | Narrow broad component evidence and improve confidence calibration for exact file questions. |

## Latest Baton Result

Run: `feature/skill-registry-doctor`, skill-manager track milestone 1: registry integrity and doctor.

| Check | Result |
| --- | ---: |
| Focused skill registry/source tests | 10/10 passed |
| Focused formatting check | Passed |
| Typecheck | Passed |
| Lint | Passed |
| Full unit suite | 451/451 passed |
| PI-Bench | 25/25 passed |
| PI-Bench average research readiness | 76/100 |
| CLI process smoke | 20/20 passed, including audited and pinned disposable skill content |
| Install-local smoke | 5/5 passed |
| Pack/public check | Passed |
| Diff whitespace check | Passed |
| Brain entry size guard | Passed: `packages/brain/src/index.ts` is 1,045,832 bytes |
| Footprint | Passed: 51ms cold start, 200KB counted core |
| Full `pnpm check` | Passed |

Current verdict: concurrent skill pins are serialized around the global registry read-modify-write,
so independent additions cannot overwrite each other. `rizz skills doctor` validates registry
schema and cache integrity, reports tampered, missing, and orphaned objects without mutation, and
requires explicit approval before moving orphaned objects to quarantine. Registered cache objects
and repository files are never deleted or changed.

Read-only real-vault UAT on `/Users/lokesh/Documents/Personal/My Agents` inspected 368 Markdown
documents: 141 product, 120 brain, 48 governance, 37 handoff, 13 work, and 9 planning documents. The
preview reported 1,657 duplicate claims, 28 naming conflicts, 408 stale absolute paths, and 4
redacted secret-like findings; apply was intentionally not attempted because reconciliation is
required.

## Latest Alembic Real-Repo UAT

Run: fresh scans from `feature/alembic-real-repo-uat`, no provider calls.

| Target | Result | DBMS evidence |
| --- | --- | --- |
| `miguelgrinberg/microblog` | 72 files in 3.1s; 3 components, 23 flows; capability average 87/100, Architecture Reasoning 61/100. | 16 table entities, including 11 Alembic and 5 SQLAlchemy entities; 7 foreign-key relationships, 0 unknown targets. |
| `fastapi/full-stack-fastapi-template` | 217 files in 14.7s; 6 components, 49 flows, 11 commands, 29 tests; capability average 87/100, Architecture Reasoning 61/100. | 7 Alembic table entities; 3 foreign-key relationships, 0 unknown targets. |
| `hotosm/tasking-manager` migrations | All 102 migration files in 1.03s; migration-only capability average 59/100 because the slice intentionally has no routes or tests. | 102 Alembic entities; 77 foreign-key relationships, 0 unknown targets; canonical dependency edges reduced from 675 to 66. |
| `hotosm/tasking-manager` full repo | All 1,515 files completed in 112.2s; 8 components, 417 flows, 16 commands, 496 tests; capability average 89/100, Architecture Reasoning 66/100. | Full migration and application analysis now completes inside the 180s UAT cap; redaction safety remains 100 with zero unsafe sensitive references. |

## Latest DBMS-Like UAT Agent Results

Run: QA sidecar on public DBMS-style repos, using fresh rizz `develop` and temp target clones.

| Repo | rizz result | Usefulness | Speedup | Main misses |
| --- | --- | ---: | ---: | --- |
| `iampranavdhar/Library-Management-System-MERN` | 66 files, 2 components, 26 flows, 5 commands, 0 tests; backend/frontend split was useful. | 7/10 | 3-4x orientation speedup | Addressed this baton: nested package manager, Mongoose model entities, route review breadth, unusable test suggestions. Remaining: backend/frontend test ownership precision. |
| `manascb1344/Online-Auction-System` | 69 files, 3 components, 32 flows, 7 commands, 0 tests; client/server/database split and read-first paths were useful. | 6/10 | 2.5-3.5x orientation speedup | Addressed this baton: nested package manager, SQL table entities, controller review breadth, unusable test suggestions. Remaining: generic component wording and deeper SQL relationship parsing. |
| `Yogndrr/MERN-School-Management-System` | 101 scanned files, 2 components, 61 flows, 7 commands, 0 tests; nested npm and 7 Mongoose models detected. | 7/10 | 2-3x orientation speedup | Addressed this baton: frontend test leakage on backend diffs, controller service linking, noisy Mongoose option keys, parallel explain race. Remaining: exact controller-to-route handler semantics. |
| `sreyas-b-anand/dbms-mini-project` | 108 scanned files, 2 components, 15 flows, 4 commands, 0 tests; nested npm worked and wallet route review was narrow. | 6/10 | 2x orientation speedup | Addressed this baton: SQLAlchemy/Alembic entities, MySQL vs SQLite labeling, parallel explain race, Flask route-to-service/model causality. Remaining: deeper Python package edge cases and SQLAlchemy relationship parsing. |

UAT verdict: rizz is now a useful agent cold-start accelerator on DBMS-style repos, mostly for
boundary mapping, read-first orientation, route inventory, command ownership, and schema/entity
inspection. The next DBMS usefulness baton is SQLAlchemy relationship precision: relationship(),
ForeignKey, back_populates/backref, and cross-table blast radius for route/service flows.

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

Capability detail from `<project-workspace>/research/understanding_score.json`:

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
Historical report: `<historical-uat-workspace>/repair-packet-precision-120-report.json`

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
