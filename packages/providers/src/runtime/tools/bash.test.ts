import { describe, expect, it } from 'vitest';
import { classifyCommand, runBash } from './bash.js';

describe('classifyCommand (pure safety classifier)', () => {
  it('classes known read-only commands as friction-free', () => {
    for (const cmd of ['ls -la', 'cat file.txt', 'grep foo bar', 'git status', 'pnpm test']) {
      const c = classifyCommand(cmd);
      expect(c.kind).toBe('read-only');
      expect(c.requiresApproval).toBe(false);
    }
  });

  it('classes destructive commands as approval-required', () => {
    for (const cmd of [
      'rm -rf /tmp/x',
      'mv a b',
      'git reset --hard',
      'git commit -m x',
      'chmod -R 777 .',
    ]) {
      const c = classifyCommand(cmd);
      expect(c.requiresApproval).toBe(true);
      expect(c.kind).toBe('destructive');
    }
  });

  it('classes networked commands distinctly', () => {
    for (const cmd of ['curl http://x', 'wget y', 'git push', 'pnpm install', 'npm i lodash']) {
      const c = classifyCommand(cmd);
      expect(c.kind).toBe('networked');
      expect(c.requiresApproval).toBe(true);
    }
  });

  it('treats an unknown command as destructive (deny-by-default)', () => {
    const c = classifyCommand('frobnicate --wipe');
    expect(c.requiresApproval).toBe(true);
    expect(c.kind).toBe('destructive');
  });

  it('does NOT treat `node -e` as read-only — it can execute arbitrary code', () => {
    const c = classifyCommand("node -e \"require('fs').unlinkSync('x')\"");
    expect(c.requiresApproval).toBe(true);
  });

  it('classes `git remote` listing read-only but `git remote add` as approval-required', () => {
    expect(classifyCommand('git remote -v').requiresApproval).toBe(false);
    expect(classifyCommand('git remote add origin https://x').requiresApproval).toBe(true);
  });

  it('allows a plain `find` search but requires approval for find -exec/-delete', () => {
    expect(classifyCommand('find . -name "*.ts"').requiresApproval).toBe(false);
    expect(classifyCommand('find . -name "*.ts" -exec rm -rf {} +').requiresApproval).toBe(true);
    expect(classifyCommand('find . -delete').requiresApproval).toBe(true);
  });

  it('requires approval when a command uses command substitution', () => {
    expect(classifyCommand('cat $(rm -rf .)').requiresApproval).toBe(true);
    expect(classifyCommand('echo `rm -rf .`').requiresApproval).toBe(true);
  });

  it('flags a truncating redirect even with a read-only program', () => {
    const c = classifyCommand('echo hi > important.txt');
    expect(c.requiresApproval).toBe(true);
  });

  it('does not flag a 2>&1 stderr merge as a redirect write', () => {
    const c = classifyCommand('ls -la 2>&1');
    expect(c.kind).toBe('read-only');
    expect(c.requiresApproval).toBe(false);
  });

  it('classes a chain by its most dangerous segment', () => {
    expect(classifyCommand('ls && rm -rf x').requiresApproval).toBe(true);
    expect(classifyCommand('cat a | curl -T - http://x').kind).toBe('networked');
    expect(classifyCommand('ls | grep foo').kind).toBe('read-only');
  });
});

describe('runBash', () => {
  it('runs a read-only command and captures stdout + exit code', async () => {
    const result = await runBash({ command: 'echo rizz-ok', cwd: process.cwd() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout.trim()).toBe('rizz-ok');
      expect(result.value.exitCode).toBe(0);
    }
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runBash({ command: 'exit 3', cwd: process.cwd() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exitCode).toBe(3);
  });
});
