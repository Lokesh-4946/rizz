import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireResourceLease,
  cacheExactContext,
  configureResourcePolicy,
  readResourceStatus,
  recordResourceUsage,
  releaseResourceLease,
  resolveCompactedContext,
} from './resource-governance.js';

const roots: string[] = [];

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'rizz-resource-repo-'));
  const rizzHome = await mkdtemp(join(tmpdir(), 'rizz-resource-home-'));
  roots.push(rootDir, rizzHome);
  execFileSync('git', ['init', '-q'], { cwd: rootDir });
  await writeFile(join(rootDir, 'README.md'), '# fixture\n');
  return { rootDir, rizzHome };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resource-governed loop', () => {
  it('returns a deterministic single-agent default without changing the repository', async () => {
    const setup = await fixture();
    const status = await readResourceStatus(setup);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.policy).toMatchObject({
      max_concurrent_agents: 1,
      max_context_bytes: 262_144,
      max_provider_cost_cents: 0,
    });
    await expect(stat(join(setup.rootDir, '.rizz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores an explicit bounded policy only in the isolated project workspace', async () => {
    const setup = await fixture();
    const configured = await configureResourcePolicy({
      ...setup,
      policy: { max_concurrent_agents: 2, max_context_bytes: 65_536, lease_ms: 60_000 },
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.value.policy.max_concurrent_agents).toBe(2);
    expect(configured.value.policy_path).toContain(setup.rizzHome);
    expect(await readFile(configured.value.policy_path, 'utf8')).toContain('65536');
  });

  it('enforces concurrency and reclaims expired leases deterministically', async () => {
    const setup = await fixture();
    const first = await acquireResourceLease({
      ...setup,
      workId: 'work-1',
      agent: 'codex',
      now: new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(first.ok).toBe(true);
    const blocked = await acquireResourceLease({
      ...setup,
      workId: 'work-2',
      agent: 'claude',
      now: new Date('2026-07-12T00:01:00.000Z'),
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'RESOURCE_CAPACITY_EXHAUSTED' } });
    const reclaimed = await acquireResourceLease({
      ...setup,
      workId: 'work-2',
      agent: 'claude',
      now: new Date('2026-07-12T00:31:00.000Z'),
    });
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) {
      expect(reclaimed.value.reclaimed_lease_ids).toHaveLength(1);
      const released = await releaseResourceLease({ ...setup, leaseId: reclaimed.value.lease_id });
      expect(released).toMatchObject({ ok: true, value: { released: true } });
    }
  });

  it('caches a redacted exact original by content digest and falls back on evidence gaps', async () => {
    const setup = await fixture();
    const cached = await cacheExactContext({
      ...setup,
      kind: 'tool-output',
      content: 'head\nsk-test-secret-12345678901234567890\nFAIL assertion\ntail',
    });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(await readFile(cached.value.object_path, 'utf8')).not.toContain('sk-test-secret');
    const resolved = await resolveCompactedContext({
      ...setup,
      digest: cached.value.digest,
      compacted: 'head\n…\ntail',
      hasEvidenceGap: true,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.used_exact_fallback).toBe(true);
      expect(resolved.value.content).toContain('FAIL assertion');
    }
  });

  it('records local resource observability against one work item', async () => {
    const setup = await fixture();
    const recorded = await recordResourceUsage({
      ...setup,
      workId: 'work-1',
      inputBytes: 1000,
      outputBytes: 250,
      cacheHit: true,
      rereads: 0,
      elapsedMs: 500,
      providerCostCents: 0,
      verificationMs: 120,
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok) expect(recorded.value.estimated_tokens).toBe(313);
  });
});
