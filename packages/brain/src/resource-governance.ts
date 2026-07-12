import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { prepareProjectStore } from './project-store.js';
import { redactSensitiveText } from './sensitivity.js';

export interface ResourcePolicy {
  readonly max_concurrent_agents: number;
  readonly max_context_bytes: number;
  readonly lease_ms: number;
  readonly max_command_ms: number;
  readonly max_provider_cost_cents: number;
}

interface ResourceOptions {
  readonly rootDir: string;
  readonly rizzHome?: string;
}

interface ResourceLease {
  readonly lease_id: string;
  readonly work_id: string;
  readonly agent: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

interface UsageRecord {
  readonly work_id: string;
  readonly recorded_at: string;
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly estimated_tokens: number;
  readonly cache_hit: boolean;
  readonly rereads: number;
  readonly elapsed_ms: number;
  readonly provider_cost_cents: number;
  readonly verification_ms: number;
}

type ResourceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const DEFAULT_POLICY: ResourcePolicy = {
  max_concurrent_agents: 1,
  max_context_bytes: 262_144,
  lease_ms: 1_800_000,
  max_command_ms: 600_000,
  max_provider_cost_cents: 0,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeVerified(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if ((await readFile(path, 'utf8')) !== contents)
    throw new Error(`write verification failed: ${path}`);
}

async function withLock<T>(projectDir: string, action: () => Promise<T>): Promise<T> {
  const path = join(projectDir, 'work', 'resource.lock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(path);
      try {
        return await action();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await wait(10);
    }
  }
  throw new Error('timed out acquiring resource governance lock');
}

function validPolicy(policy: ResourcePolicy): boolean {
  return (
    Number.isInteger(policy.max_concurrent_agents) &&
    policy.max_concurrent_agents >= 1 &&
    policy.max_concurrent_agents <= 32 &&
    Number.isInteger(policy.max_context_bytes) &&
    policy.max_context_bytes >= 16_384 &&
    policy.max_context_bytes <= 16_777_216 &&
    Number.isInteger(policy.lease_ms) &&
    policy.lease_ms >= 60_000 &&
    policy.lease_ms <= 86_400_000 &&
    Number.isInteger(policy.max_command_ms) &&
    policy.max_command_ms >= 1_000 &&
    policy.max_command_ms <= 86_400_000 &&
    Number.isInteger(policy.max_provider_cost_cents) &&
    policy.max_provider_cost_cents >= 0
  );
}

async function store(options: ResourceOptions) {
  return prepareProjectStore({
    rootDir: options.rootDir,
    ...(options.rizzHome === undefined ? {} : { rizzHome: options.rizzHome }),
  });
}

async function policyAt(projectDir: string): Promise<ResourcePolicy> {
  const parsed = await optionalJson(join(projectDir, 'governance', 'resource-policy.json'));
  if (!isRecord(parsed)) return DEFAULT_POLICY;
  const candidate = parsed as unknown as ResourcePolicy;
  return validPolicy(candidate) ? candidate : DEFAULT_POLICY;
}

async function leasesAt(projectDir: string): Promise<ResourceLease[]> {
  const parsed = await optionalJson(join(projectDir, 'work', 'resource-leases.json'));
  if (!isRecord(parsed) || !Array.isArray(parsed.leases)) return [];
  return parsed.leases.filter(
    (lease): lease is ResourceLease =>
      isRecord(lease) &&
      typeof lease.lease_id === 'string' &&
      typeof lease.work_id === 'string' &&
      typeof lease.agent === 'string' &&
      typeof lease.acquired_at === 'string' &&
      typeof lease.expires_at === 'string',
  );
}

export async function readResourceStatus(options: ResourceOptions): Promise<
  ResourceResult<{
    readonly project_id: string;
    readonly policy: ResourcePolicy;
    readonly active_leases: readonly ResourceLease[];
  }>
> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  const now = Date.now();
  const leases = (await leasesAt(prepared.value.projectDir)).filter(
    (lease) => Date.parse(lease.expires_at) > now,
  );
  return {
    ok: true,
    value: {
      project_id: prepared.value.projectId,
      policy: await policyAt(prepared.value.projectDir),
      active_leases: leases,
    },
  };
}

export async function configureResourcePolicy(
  options: ResourceOptions & { readonly policy: Partial<ResourcePolicy> },
): Promise<ResourceResult<{ readonly policy: ResourcePolicy; readonly policy_path: string }>> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  const policy = { ...(await policyAt(prepared.value.projectDir)), ...options.policy };
  if (!validPolicy(policy)) {
    return {
      ok: false,
      error: {
        code: 'RESOURCE_POLICY_INVALID',
        message: 'Resource policy is outside safe bounds.',
      },
    };
  }
  const policyPath = join(prepared.value.projectDir, 'governance', 'resource-policy.json');
  await writeVerified(policyPath, policy);
  return { ok: true, value: { policy, policy_path: policyPath } };
}

export async function acquireResourceLease(
  options: ResourceOptions & {
    readonly workId: string;
    readonly agent: string;
    readonly now?: Date;
  },
): Promise<ResourceResult<ResourceLease & { readonly reclaimed_lease_ids: readonly string[] }>> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  return withLock(prepared.value.projectDir, async () => {
    const now = options.now ?? new Date();
    const leases = await leasesAt(prepared.value.projectDir);
    const active = leases.filter((lease) => Date.parse(lease.expires_at) > now.getTime());
    const reclaimed = leases
      .filter((lease) => Date.parse(lease.expires_at) <= now.getTime())
      .map((lease) => lease.lease_id);
    const policy = await policyAt(prepared.value.projectDir);
    if (active.length >= policy.max_concurrent_agents) {
      return {
        ok: false,
        error: {
          code: 'RESOURCE_CAPACITY_EXHAUSTED',
          message: 'Active resource leases reached the configured concurrency limit.',
        },
      };
    }
    const lease: ResourceLease = {
      lease_id: randomUUID(),
      work_id: redactSensitiveText(options.workId),
      agent: redactSensitiveText(options.agent),
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + policy.lease_ms).toISOString(),
    };
    await writeVerified(join(prepared.value.projectDir, 'work', 'resource-leases.json'), {
      schema_version: 1,
      leases: [...active, lease],
    });
    return { ok: true, value: { ...lease, reclaimed_lease_ids: reclaimed } };
  });
}

export async function releaseResourceLease(
  options: ResourceOptions & { readonly leaseId: string },
): Promise<ResourceResult<{ readonly released: boolean; readonly lease_id: string }>> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  return withLock(prepared.value.projectDir, async () => {
    const leases = await leasesAt(prepared.value.projectDir);
    const remaining = leases.filter((lease) => lease.lease_id !== options.leaseId);
    const released = remaining.length !== leases.length;
    await writeVerified(join(prepared.value.projectDir, 'work', 'resource-leases.json'), {
      schema_version: 1,
      leases: remaining,
    });
    return { ok: true, value: { released, lease_id: options.leaseId } };
  });
}

export async function cacheExactContext(
  options: ResourceOptions & { readonly kind: string; readonly content: string },
): Promise<
  ResourceResult<{ readonly digest: string; readonly object_path: string; readonly bytes: number }>
> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  const content = redactSensitiveText(options.content);
  const digest = createHash('sha256').update(content).digest('hex');
  const directory = join(prepared.value.projectDir, 'cache', 'objects', 'sha256');
  const objectPath = join(directory, digest);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(objectPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if ((await readFile(objectPath, 'utf8')) !== content) {
    return {
      ok: false,
      error: {
        code: 'RESOURCE_CACHE_COLLISION',
        message: 'Cached digest content did not match the sanitized exact original.',
      },
    };
  }
  return {
    ok: true,
    value: { digest, object_path: objectPath, bytes: Buffer.byteLength(content) },
  };
}

export async function resolveCompactedContext(
  options: ResourceOptions & {
    readonly digest: string;
    readonly compacted: string;
    readonly hasEvidenceGap: boolean;
  },
): Promise<ResourceResult<{ readonly content: string; readonly used_exact_fallback: boolean }>> {
  if (!/^[a-f0-9]{64}$/.test(options.digest)) {
    return {
      ok: false,
      error: { code: 'RESOURCE_DIGEST_INVALID', message: 'Context digest must be SHA-256 hex.' },
    };
  }
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  if (!options.hasEvidenceGap) {
    return { ok: true, value: { content: options.compacted, used_exact_fallback: false } };
  }
  try {
    const content = await readFile(
      join(prepared.value.projectDir, 'cache', 'objects', 'sha256', options.digest),
      'utf8',
    );
    return { ok: true, value: { content, used_exact_fallback: true } };
  } catch {
    return {
      ok: false,
      error: {
        code: 'RESOURCE_EXACT_ORIGINAL_MISSING',
        message: 'Exact cached context is unavailable.',
      },
    };
  }
}

export async function recordResourceUsage(
  options: ResourceOptions & {
    readonly workId: string;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly cacheHit: boolean;
    readonly rereads: number;
    readonly elapsedMs: number;
    readonly providerCostCents: number;
    readonly verificationMs: number;
    readonly now?: Date;
  },
): Promise<ResourceResult<UsageRecord>> {
  const prepared = await store(options);
  if (!prepared.ok) return prepared;
  const values = [
    options.inputBytes,
    options.outputBytes,
    options.rereads,
    options.elapsedMs,
    options.providerCostCents,
    options.verificationMs,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    return {
      ok: false,
      error: {
        code: 'RESOURCE_USAGE_INVALID',
        message: 'Resource usage values must be non-negative integers.',
      },
    };
  }
  const record: UsageRecord = {
    work_id: redactSensitiveText(options.workId),
    recorded_at: (options.now ?? new Date()).toISOString(),
    input_bytes: options.inputBytes,
    output_bytes: options.outputBytes,
    estimated_tokens: Math.ceil((options.inputBytes + options.outputBytes) / 4),
    cache_hit: options.cacheHit,
    rereads: options.rereads,
    elapsed_ms: options.elapsedMs,
    provider_cost_cents: options.providerCostCents,
    verification_ms: options.verificationMs,
  };
  await withLock(prepared.value.projectDir, async () => {
    const path = join(prepared.value.projectDir, 'evidence', 'resource-usage.json');
    const parsed = await optionalJson(path);
    const records = isRecord(parsed) && Array.isArray(parsed.records) ? parsed.records : [];
    await writeVerified(path, { schema_version: 1, records: [...records, record] });
  });
  return { ok: true, value: record };
}
