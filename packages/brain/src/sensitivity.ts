import { createHash } from 'node:crypto';

export interface SensitivePathClassification {
  readonly isSensitive: boolean;
  readonly redactedId: string;
  readonly label: string;
  readonly reason: string;
}

const REDACTED_PREFIX = 'redacted:sensitive-file:';

const SECRET_VALUE_PATTERNS = [
  /\bsk-or-v1-[a-z0-9]{16,}\b/gi,
  /\bsk-[a-z0-9][a-z0-9_-]{8,}\b/gi,
  /\bgh[pousr]_[a-z0-9_]{20,}\b/gi,
  /\bBearer\s+[a-z0-9._~+/-]+=*/gi,
] as const;

const PRIVATE_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
]);

const PRIVATE_EXTENSIONS = new Set(['.pem', '.key', '.cert', '.crt', '.cer', '.p12', '.pfx']);

const SENSITIVE_SEGMENT_PATTERN =
  /(^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwords|passwd|client_secret|service-account|private-key)([-_.]|$)/i;

const PRIVATE_ABSOLUTE_PATH_PATTERN =
  /^(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/)/i;

const SENSITIVE_TEXT_CANDIDATE =
  /(?:\/Users\/[^\s"'<>]+|\/home\/[^\s"'<>]+|\/private\/[^\s"'<>]+|\/tmp\/[^\s"'<>]+|\/var\/folders\/[^\s"'<>]+|(?:[A-Za-z0-9@._~+:-]+\/)*[A-Za-z0-9@._~+:-]*(?:sk-or-v1-[A-Za-z0-9]+|secret|secrets|credential|credentials|token|tokens|password|passwords|passwd|client_secret|service-account|private-key|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.netrc|[A-Za-z0-9_.-]+\.(?:pem|key|cert|crt|cer|p12|pfx))[A-Za-z0-9@._~+:-]*)/gi;

const TRAILING_CANDIDATE_PUNCTUATION = /[),.;!?]+$/;
const LEADING_CANDIDATE_PUNCTUATION = /^[([{'"`]+/;

export function normalizeSensitivePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function hashSensitiveValue(value: string): string {
  return createHash('sha256').update(normalizeSensitivePath(value)).digest('hex').slice(0, 12);
}

export function redactedSensitiveReference(value: string): string {
  return `${REDACTED_PREFIX}${hashSensitiveValue(value)}`;
}

function emptyClassification(value: string): SensitivePathClassification {
  return {
    isSensitive: false,
    redactedId: redactedSensitiveReference(value),
    label: value,
    reason: 'not sensitive',
  };
}

function hasSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function splitCandidate(value: string): {
  readonly prefix: string;
  readonly candidate: string;
  readonly suffix: string;
} {
  const prefix = value.match(LEADING_CANDIDATE_PUNCTUATION)?.[0] ?? '';
  const withoutPrefix = value.slice(prefix.length);
  const suffix = withoutPrefix.match(TRAILING_CANDIDATE_PUNCTUATION)?.[0] ?? '';
  return {
    prefix,
    candidate: withoutPrefix.slice(0, withoutPrefix.length - suffix.length),
    suffix,
  };
}

function isLikelyPathOrFileName(value: string): boolean {
  const normalized = normalizeSensitivePath(value);
  if (normalized === '' || normalized.includes(REDACTED_PREFIX)) return false;
  if (PRIVATE_ABSOLUTE_PATH_PATTERN.test(normalized)) return true;
  if (normalized.includes('/')) return true;
  const leaf =
    normalized
      .split('/')
      .filter((segment) => segment !== '')
      .at(-1) ?? normalized;
  const lowerLeaf = leaf.toLowerCase();
  if (lowerLeaf === '.env.example') return true;
  if (PRIVATE_FILE_NAMES.has(lowerLeaf)) return true;
  if (lowerLeaf.startsWith('.env.')) return true;
  if (PRIVATE_EXTENSIONS.has(extensionOf(lowerLeaf))) return true;
  if (hasSecretLikeValue(normalized) && extensionOf(lowerLeaf) !== '') return true;
  if (extensionOf(lowerLeaf) !== '' && SENSITIVE_SEGMENT_PATTERN.test(lowerLeaf)) return true;
  return SENSITIVE_SEGMENT_PATTERN.test(lowerLeaf) && /[-_.]/.test(lowerLeaf);
}

export function classifySensitivePath(value: string): SensitivePathClassification {
  const normalized = normalizeSensitivePath(value);
  if (normalized === '' || normalized.includes(REDACTED_PREFIX)) {
    return emptyClassification(normalized);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const leaf = segments[segments.length - 1] ?? normalized;
  const lowerLeaf = leaf.toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const redactedId = redactedSensitiveReference(normalized);
  const sensitive = (reason: string): SensitivePathClassification => ({
    isSensitive: true,
    redactedId,
    label: `sensitive file redacted (${redactedId})`,
    reason,
  });

  if (hasSecretLikeValue(normalized)) return sensitive('secret-like token in path');
  if (PRIVATE_ABSOLUTE_PATH_PATTERN.test(normalized)) return sensitive('private absolute path');
  if (lowerLeaf === '.env.example') return emptyClassification(normalized);
  if (PRIVATE_FILE_NAMES.has(lowerLeaf)) return sensitive(`private filename ${lowerLeaf}`);
  if (lowerLeaf.startsWith('.env.')) return sensitive('private environment filename');
  if (PRIVATE_EXTENSIONS.has(extensionOf(lowerLeaf)))
    return sensitive('private key or certificate filename');
  if (lowerSegments.includes('.aws') && lowerLeaf === 'credentials') {
    return sensitive('cloud credential path');
  }
  if (lowerSegments.some((segment) => SENSITIVE_SEGMENT_PATTERN.test(segment))) {
    return sensitive('sensitive path segment');
  }
  return emptyClassification(normalized);
}

export function shouldOmitSensitivePath(value: string): boolean {
  const normalized = normalizeSensitivePath(value);
  const leaf =
    normalized
      .split('/')
      .filter((segment) => segment !== '')
      .at(-1) ?? normalized;
  const lowerLeaf = leaf.toLowerCase();
  if (lowerLeaf === '.env.example') return false;
  if (PRIVATE_FILE_NAMES.has(lowerLeaf)) return true;
  if (lowerLeaf.startsWith('.env.')) return true;
  if (PRIVATE_EXTENSIONS.has(extensionOf(lowerLeaf))) return true;
  if (normalized.toLowerCase().endsWith('/.aws/credentials')) return true;
  return false;
}

export function redactSecretValues(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (match) =>
        match.startsWith('Bearer ') ? 'Bearer [redacted secret]' : '[redacted secret]',
      ),
    value,
  );
}

export function redactSensitiveText(value: string): string {
  if (value.startsWith(REDACTED_PREFIX)) return value;
  const normalized = normalizeSensitivePath(value);
  if (!/\s/.test(normalized)) {
    const classification = classifySensitivePath(normalized);
    if (classification.isSensitive) return classification.redactedId;
  }
  const pathRedacted = value.replace(SENSITIVE_TEXT_CANDIDATE, (match, offset, text) => {
    if (match.startsWith(REDACTED_PREFIX)) return match;
    const { prefix, candidate, suffix } = splitCandidate(match);
    const nextCharacter = text.slice(offset + match.length, offset + match.length + 1);
    const previousText = text.slice(Math.max(0, offset - 16), offset);
    if (nextCharacter === '=' && !candidate.includes('/')) return match;
    if (/\bBearer\s+$/i.test(previousText)) return match;
    if (!isLikelyPathOrFileName(candidate)) return match;
    const matchClassification = classifySensitivePath(candidate);
    return matchClassification.isSensitive
      ? `${prefix}${matchClassification.redactedId}${suffix}`
      : match;
  });
  return redactSecretValues(pathRedacted);
}

export function sensitiveIdentityKey(value: string): string {
  const classification = classifySensitivePath(value);
  return classification.isSensitive ? classification.redactedId : normalizeSensitivePath(value);
}

export function redactedReferenceCount(value: unknown): number {
  if (typeof value === 'string') {
    const matches = value.match(
      new RegExp(REDACTED_PREFIX.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'), 'g'),
    );
    const directSensitive =
      isLikelyPathOrFileName(value) && classifySensitivePath(value).isSensitive ? 1 : 0;
    return (matches?.length ?? 0) + directSensitive;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + redactedReferenceCount(item), 0);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).reduce(
      (count, [key, item]) => count + redactedReferenceCount(key) + redactedReferenceCount(item),
      0,
    );
  }
  return 0;
}

export function containsSensitiveReference(value: unknown): boolean {
  return redactedReferenceCount(value) > 0;
}

export function unredactedSensitiveReferenceCount(value: unknown): number {
  if (typeof value === 'string') {
    return isLikelyPathOrFileName(value) && classifySensitivePath(value).isSensitive ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + unredactedSensitiveReferenceCount(item), 0);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).reduce(
      (count, [key, item]) =>
        count + unredactedSensitiveReferenceCount(key) + unredactedSensitiveReferenceCount(item),
      0,
    );
  }
  return 0;
}
