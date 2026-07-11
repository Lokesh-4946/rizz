import { describe, expect, it } from 'vitest';
import {
  classifySensitivePath,
  containsSecretLikeValue,
  redactSensitiveSet,
  redactSensitiveText,
  redactedSensitiveReference,
  sensitiveIdentityKey,
  shouldOmitSensitivePath,
} from './sensitivity.js';

describe('sensitive path classification', () => {
  it('distinguishes design-token prose from credential-shaped values', () => {
    expect(
      containsSecretLikeValue(
        'Tailwind with CSS-variable design tokens. Colors are tokens; see notes/brand-tokens.md.',
      ),
    ).toBe(false);
    expect(containsSecretLikeValue('OPENAI_API_KEY=sk-or-v1-fixturesecret0000000000000000')).toBe(
      true,
    );
  });

  it('classifies private env, credential, token, password, key, and cert names', () => {
    const sensitive = [
      '.env',
      '.env.production',
      '.npmrc',
      '.netrc',
      'id_rsa',
      'client_secret.json',
      'service-account-prod.json',
      'passwords.txt',
      'src/sk-or-v1-pathsecret0000000000000000.ts',
      '/tmp/rizz-brain-test-secret/src/index.ts',
      'certs/server.pem',
      'keys/server.key',
      '.aws/credentials',
    ];

    for (const path of sensitive) {
      const classification = classifySensitivePath(path);
      expect(classification.isSensitive, path).toBe(true);
      expect(classification.redactedId).toMatch(/^redacted:sensitive-file:[a-f0-9]{12}$/);
      expect(classification.redactedId).not.toContain(path);
      expect(redactSensitiveText(path)).toBe(classification.redactedId);
    }
  });

  it('preserves public examples while omitting private material', () => {
    expect(classifySensitivePath('.env.example').isSensitive).toBe(false);
    expect(shouldOmitSensitivePath('.env.example')).toBe(false);
    expect(shouldOmitSensitivePath('.env.local')).toBe(true);
    expect(shouldOmitSensitivePath('server.key')).toBe(true);
    expect(shouldOmitSensitivePath('src/sk-or-v1-pathsecret0000000000000000.ts')).toBe(false);
  });

  it('produces stable distinct redacted identity keys', () => {
    const first = sensitiveIdentityKey('src/sk-or-v1-alpha0000000000000000.ts');
    const firstAgain = sensitiveIdentityKey('src/sk-or-v1-alpha0000000000000000.ts');
    const second = sensitiveIdentityKey('src/sk-or-v1-beta0000000000000000.ts');

    expect(first).toBe(firstAgain);
    expect(first).not.toBe(second);
    expect(first).toBe(redactedSensitiveReference('src/sk-or-v1-alpha0000000000000000.ts'));
  });

  it('redacts sensitive paths embedded in user-facing text', () => {
    const output = redactSensitiveText(
      'File evidence from src/sk-or-v1-pathsecret0000000000000000.ts, client_secret.json, and file:///tmp/public-build/output.json.',
    );

    expect(output).not.toContain('sk-or-v1-pathsecret');
    expect(output).not.toContain('client_secret');
    expect(output).not.toContain('/tmp/public-build');
    expect(output).toContain('redacted:sensitive-file:');
  });

  it('preserves embedded redacted references across repeated sanitization', () => {
    const reference = redactedSensitiveReference('/tmp/private-secret/config.json');
    const input = `Evidence ${reference}; inspect /tmp/another-private-secret/config.json.`;
    const output = redactSensitiveText(input);

    expect(output).toContain(reference);
    expect(output).not.toContain('/tmp/another-private-secret');
    expect(redactSensitiveText(output)).toBe(output);
    expect(redactSensitiveSet(['/tmp/private-secret/config.json', reference])).toEqual([reference]);
  });

  it('keeps command structure while redacting secret values', () => {
    const output = redactSensitiveText(
      'OPENAI_API_KEY=sk-ant-brainsecret0000000000000000 ghp_token=ghp_brainsecret000000000000000 vitest run --header "Authorization: Bearer brain.secret.token"',
    );

    expect(output).toContain('OPENAI_API_KEY=[redacted secret]');
    expect(output).toContain('ghp_token=[redacted secret]');
    expect(output).toContain('Authorization: Bearer [redacted secret]');
    expect(output).not.toContain('redacted:sensitive-file:');
  });

  it('does not redact public env examples embedded in prose', () => {
    const output = redactSensitiveText('Configuration artifact detected at .env.example.');

    expect(output).toBe('Configuration artifact detected at .env.example.');
  });

  it('scans long benign text without candidate backtracking', () => {
    const input = `${'a'.repeat(2_000)} /tmp/private-secret/config.json`;
    const startedAt = performance.now();
    const output = redactSensitiveText(input);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(output).not.toContain('/tmp/private-secret');
    expect(output).toContain('redacted:sensitive-file:');
  });
});
