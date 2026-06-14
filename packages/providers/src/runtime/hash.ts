// Fast non-cryptographic content hash (FNV-1a, 64-bit) used to anchor edits and verify writes
// byte-for-byte. Built-in arithmetic only — no dependency (lightweight constraint, CLAUDE.md §2).
// This is NOT a security primitive: its only job is to detect that the bytes on disk match the
// bytes we intended to write (edit-verify-after-write, design §2.4).

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** A stable 16-char hex digest of the UTF-8 bytes of `content`. */
export function contentHash(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by bytes.length.
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}
