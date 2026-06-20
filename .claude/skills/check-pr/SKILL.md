---
name: check-pr
description: Inspect a GitHub, GitLab, or Perforce PR/MR/CL before merge without invoking external review bots. Use when a rizz Git, Infra, DevOps, QA, or PR owner needs to check review comments, CI/status checks, PR description completeness, changed-file scope, and whether the PR is ready for the local review-loop skill.
---

# Check PR

## Purpose

Use this as the PR state gate. It checks the change that already exists, gathers review and CI state,
and reports actionable issues without invoking any external review bot.

## Workflow

1. Identify the review object.
   - GitHub: `gh pr view --json number,title,body,state,headRefName,headRefOid,statusCheckRollup`
   - GitLab: `glab mr view --output json`
   - Perforce: inspect the pending or shelved changelist with `p4 changes` and `p4 describe`.
2. Inspect changed-file scope.
   - Confirm the PR/MR/CL contains only files approved by the current baton.
   - Report out-of-scope files as release blockers unless the orchestrator explicitly widened scope.
3. Wait for status checks to settle.
   - GitHub: use `gh pr checks` or `statusCheckRollup`.
   - GitLab: inspect MR pipelines.
   - Perforce: use the team's configured review or CI surface if available.
   - Do not declare the gate clean while checks are still pending.
4. Inspect review comments and discussions.
   - GitHub: read PR reviews, inline review comments, unresolved review threads, and general issue
     comments with `updated_at` ordering.
   - GitLab: read MR notes and discussions, especially unresolved diff discussions.
   - Perforce: read CL description and configured review comments.
   - Include bot, human, CI, and deployment comments. Categorize informational noise separately.
5. Inspect the PR/MR description.
   - Check that summary, verification, scope, and out-of-scope notes match the current handoff.
   - Flag TODOs, stale test evidence, missing risk notes, and omitted lightweight-footprint evidence.
6. Handle bot comments as ordinary comments.
   - Do not post trigger comments for external review bots.
   - If bot comments already exist on the PR, read the latest relevant comment by `updated_at`.
   - Categorize existing bot comments as actionable, informational, or stale. Do not treat an absent
     external score as a release blocker.
7. Report in findings-first format.

```text
Check PR report
Platform:
Review object:
Branch / commit:
CI:
Scope:
Description:
Review comments:
Bot/comment state:
Actionable issues:
Informational items:
Recommended gate:
```

## Fixing Rules

- Fix issues only when the prompt asks this agent to fix them or when the current baton grants that
  authority.
- Preserve the approved PR scope. If a review asks for another slice, baton back to Master
  Orchestrator.
- After fixes, commit/push only the approved files and re-run the checks required by the current
  handoff.
- Resolve review threads only when the issue is actually addressed or clearly informational.

## Relationship To Review Loop

- Use `check-pr` before `review-loop`.
- Use `review-loop` to perform rizz's local iterative code review and fix cycle.
- Do not require an external bot confidence score for merge readiness.
