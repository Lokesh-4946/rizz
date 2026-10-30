#!/usr/bin/env node
// Build a self-contained @valoir/rizz-test tarball. Never publishes @valoir/rizz.
//
//   node scripts/pack-test-release.mjs
//   node scripts/pack-test-release.mjs --build 1
//   node scripts/pack-test-release.mjs --build 1 --publish \
//     --confirm-publish @valoir/rizz-test@0.4.0-test.1

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_NAME = '@valoir/rizz-test';
const FORBIDDEN_NAME = '@valoir/rizz';
const BASE_VERSION = '0.4.0';

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}

function fail(message) {
  throw new PackError(message);
}

export function parseArgs(argv) {
  let publish = false;
  let tag = '';
  let buildNumber = 1;
  let out = join(root, 'dist-pack');
  let confirm = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') publish = true;
    else if (arg === '--tag') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('--tag needs a value');
      tag = value;
      index += 1;
    } else if (arg === '--build') {
      buildNumber = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--confirm-publish') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('--confirm-publish needs a value');
      confirm = value;
      index += 1;
    } else fail(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(buildNumber) || buildNumber < 1) fail('--build must be a positive integer');
  if (out === '') fail('--out needs a directory');
  return { publish, tag, build: buildNumber, out, confirm };
}

export function testPackageVersion(buildNumber) {
  return `${BASE_VERSION}-test.${buildNumber}`;
}

function assertAllowedPackageName(name) {
  if (name === FORBIDDEN_NAME || name !== PACKAGE_NAME) {
    fail(`refusing to publish ${name}`);
  }
}

export function assertPublishRequest(options) {
  assertAllowedPackageName(PACKAGE_NAME);
  if (options.tag === 'latest') fail('refusing to publish with --tag latest');
  if (options.tag !== '' && options.tag !== 'test') {
    fail(`refusing to publish with --tag ${options.tag}`);
  }
  const version = testPackageVersion(options.build);
  const expected = `${PACKAGE_NAME}@${version}`;
  const confirm = options.confirm.trim();
  if (confirm === '') fail(`refusing to publish without --confirm-publish ${expected}`);
  const at = confirm.lastIndexOf('@');
  const name = at <= 0 ? confirm : confirm.slice(0, at);
  if (name !== PACKAGE_NAME) fail(`refusing to publish ${name}`);
  if (confirm !== expected) fail(`refusing to publish ${confirm}; expected ${expected}`);
  if (options.token === undefined || options.token === '') {
    fail('NPM_TOKEN is not set; refusing to publish');
  }
}

function envWithoutToken(env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'NPM_TOKEN') continue;
    next[key] = value;
  }
  return next;
}

function redact(message, token) {
  if (typeof message !== 'string') return '';
  if (typeof token !== 'string' || token === '') return message;
  return message.split(token).join('[redacted]');
}

function isInside(parent, child) {
  const rootPath = canonical(parent);
  const target = canonical(child);
  const rel = relative(rootPath, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function canonical(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertOutside(dir, parents) {
  for (const parent of parents) {
    if (parent === undefined || parent === '') continue;
    if (isInside(parent, dir)) {
      fail('refusing to write the npm token inside the repo or dist-pack');
    }
  }
}

function run(spawn, command, args, options) {
  const result = spawn(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error !== undefined) {
    fail(`${command} failed to start`);
  }
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`);
  return result.stdout ?? '';
}

export async function publishTestPackage(options) {
  assertPublishRequest({
    tag: options.tag ?? '',
    build: options.build,
    confirm: options.confirm,
    token: options.token,
  });
  const token = options.token;
  const spawn = options.spawn ?? spawnSync;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? process.exit;
  const listen = options.listen ?? ((signal, handler) => process.on(signal, handler));
  const unlisten = options.unlisten ?? ((signal, handler) => process.off(signal, handler));
  const parent = options.tempParent ?? tmpdir();
  const dir = mkdtempSync(join(parent, 'rizz-test-npmrc-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(dir, { recursive: true, force: true });
  };
  const onSigint = () => {
    cleanup();
    exit(130);
  };
  const onSigterm = () => {
    cleanup();
    exit(143);
  };
  try {
    listen('SIGINT', onSigint);
    listen('SIGTERM', onSigterm);
    assertOutside(dir, [options.repoRoot, options.outDir]);
    const npmrc = join(dir, 'npmrc');
    const contents = `//registry.npmjs.org/:_authToken=${token}\n`;
    writeFileSync(npmrc, contents, { mode: 0o600 });
    chmodSync(npmrc, 0o600);
    if (process.platform !== 'win32' && (statSync(npmrc).mode & 0o777) !== 0o600) {
      fail('npmrc mode was not 0600');
    }
    const childEnv = envWithoutToken(options.env ?? process.env);
    const result = spawn(
      'npm',
      ['publish', options.tarball, '--access', 'public', '--tag', 'test', '--userconfig', npmrc],
      {
        cwd: options.repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: childEnv,
      },
    );
    const outText = redact(result.stdout, token);
    const errText = redact(result.stderr, token);
    if (outText !== '') stdout.write(outText);
    if (result.status !== 0) {
      if (errText !== '') stderr.write(errText);
      fail('npm publish failed');
    }
  } finally {
    unlisten('SIGINT', onSigint);
    unlisten('SIGTERM', onSigterm);
    cleanup();
  }
}

export async function packTestRelease(argv, deps = {}) {
  const options = parseArgs(argv);
  const version = testPackageVersion(options.build);
  const spawn = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;
  const repoRoot = deps.root ?? root;
  const stdout = deps.stdout ?? process.stdout;
  assertAllowedPackageName(PACKAGE_NAME);
  if (options.publish) {
    assertPublishRequest({
      tag: options.tag,
      build: options.build,
      confirm: options.confirm,
      token: env.NPM_TOKEN,
    });
  }

  run(spawn, 'pnpm', ['-s', 'build'], { cwd: repoRoot, env, stdio: 'inherit' });

  const stage = join(options.out, 'rizz-test-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'bin'), { recursive: true });
  const outfile = join(stage, 'bin', 'rizz.js');
  await build({
    entryPoints: [join(repoRoot, 'packages', 'cli', 'dist', 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    legalComments: 'none',
  });
  const bundled = readFileSync(outfile, 'utf8').replace(/^#![^\n]*\n/gm, '');
  writeFileSync(outfile, `#!/usr/bin/env node\n${bundled}`);
  chmodSync(outfile, 0o755);

  const manifest = {
    name: PACKAGE_NAME,
    version,
    description: 'Test-only build of the Rizz CLI. Not the public @valoir/rizz package.',
    type: 'module',
    bin: { rizz: './bin/rizz.js' },
    files: ['bin'],
  };
  assertAllowedPackageName(manifest.name);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(options.out, { recursive: true });
  const packed = run(spawn, 'npm', ['pack', '--pack-destination', options.out, '--json'], {
    cwd: stage,
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
  });
  const info = JSON.parse(packed);
  const filename = Array.isArray(info) ? info[0]?.filename : info.filename;
  if (typeof filename !== 'string' || filename === '') fail('npm pack did not report a filename');
  const tarball = join(options.out, filename);
  const packedManifest = run(spawn, 'tar', ['-xOf', tarball, 'package/package.json'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
  });
  const packedJson = JSON.parse(packedManifest);
  assertAllowedPackageName(packedJson.name);
  if (packedJson.version !== version) fail(`tarball version is ${packedJson.version}`);
  const dependencies = packedJson.dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@valoir/')) fail(`tarball still depends on ${name}`);
  }

  stdout.write(`tarball: ${tarball}\n`);
  if (!options.publish) return { tarball, version, packageName: PACKAGE_NAME };
  await publishTestPackage({
    tarball,
    build: options.build,
    confirm: options.confirm,
    tag: options.tag,
    token: env.NPM_TOKEN,
    repoRoot,
    outDir: options.out,
    tempParent: deps.tempParent,
    spawn,
    env,
    exit: deps.exit,
    stdout,
    stderr: deps.stderr ?? process.stderr,
  });
  return { tarball, version, packageName: PACKAGE_NAME };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packTestRelease(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rizz-test: ${redact(message, process.env.NPM_TOKEN)}\n`);
    process.exit(1);
  });
}
