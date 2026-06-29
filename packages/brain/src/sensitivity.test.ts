import { describe, expect, it } from 'vitest';
import {
  classifySensitivePath,
  redactSensitiveText,
  redactedSensitiveReference,
  sensitiveIdentityKey,
  shouldOmitSensitivePath,
} from './sensitivity.js';

describe('sensitive path classification', () => {
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
      'File evidence from src/sk-or-v1-pathsecret0000000000000000.ts and client_secret.json.',
    );

    expect(output).not.toContain('sk-or-v1-pathsecret');
    expect(output).not.toContain('client_secret');
    expect(output).toContain('redacted:sensitive-file:');
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
});
