---
name: review-loop
description: Run rizz's local iterative PR/MR/CL review loop without external review bots. Use when a Git, Infra, DevOps, QA, PR, or release agent needs to self-review a diff, preserve scope, find bugs/regressions/security issues/test gaps, apply scoped fixes, rerun verification, and produce merge-readiness evidence.
---

# Review Loop

## Purpose

Use this as rizz's own review loop. It replaces external bot scoring with an agent-owned,
evidence-backed review cycle.

Run it after `check-pr` confirms the PR/MR/CL state, or when the current baton asks for local PR
review before merge.

## Inputs

- Current baton and approved file scope.
- PR/MR/CL link or local branch.
- Changed files and diff.
- Relevant handoffs, QA results, CI results, and release checklist.
- Repo instructions such as `CLAUDE.md` and `CONTRIBUTING.md`.

## Loop

Repeat up to three iterations:

1. Build the review packet.
   - Read the current baton, approved scope, changed files, and PR/MR/CL description.
   - Inspect the committed diff against the target branch.
   - Confirm no package manifest, lockfile, core dependency, or out-of-scope file changed unless the
     baton explicitly allowed it.
2. Review findings-first.
   - Prioritize correctness bugs, behavioral regressions, secret leakage, unsafe commands, edit
     verification gaps, error handling gaps, cross-platform failures, and missing tests.
   - For rizz, always check the lightweight constraint: no accidental default-path dependency growth,
     no core/provider bloat, no workspace/multi-agent behavior loaded by default.
   - Treat style-only comments as informational unless they affect maintainability or local rules.
3. Decide action.
   - If there are actionable issues within approved scope, patch them.
   - If a finding requires product, architecture, provider, install, docs, or out-of-scope work,
     baton back to Master Orchestrator instead of expanding the PR.
   - If no actionable issues remain, stop the loop.
4. Verify.
   - Run the checks required by the current baton.
   - At minimum, run a whitespace check on staged or changed files.
   - For code changes, rerun focused tests and any broader release command required by risk.
5. Commit and push only if this agent owns the PR branch and the baton allows it.
   - Stage only approved files.
   - Use a conventional commit message.
   - Never stage unrelated local changes.

## Output

Report:

```text
Review Loop report
Review object:
Iterations:
Files reviewed:
Findings fixed:
Findings deferred:
Verification:
Scope status:
Merge readiness:
Baton:
```

Merge readiness is local and evidence-based. Do not claim an external bot score.
