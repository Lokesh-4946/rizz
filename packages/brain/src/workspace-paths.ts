import { join } from 'node:path';

export function outputDirFor(rootDir: string, outputDir?: string): string {
  return outputDir ?? join(rootDir, '.rizz');
}

export function verificationPath(rootDir: string, outputDir?: string): string {
  return join(outputDirFor(rootDir, outputDir), 'research', 'verification_evidence.json');
}

export function reviewEvidencePath(rootDir: string, outputDir?: string): string {
  return join(outputDirFor(rootDir, outputDir), 'research', 'review_claim_evidence.json');
}
