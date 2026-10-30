#!/usr/bin/env node
// Build a self-contained @valoir/rizz-test tarball. Never publishes @valoir/rizz.
//
//   node scripts/pack-test-release.mjs
//   node scripts/pack-test-release.mjs --build 1
//   node scripts/pack-test-release.mjs --publish --tag test

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@valoir/rizz-test';
const FORBIDDEN_NAME = '@valoir/rizz';
const BASE_VERSION = '0.4.0';

function fail(message) {
  process.stderr.write(`rizz-test: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let publish = false;
  let tag = '';
  let build = 1;
  let out = join(root, 'dist-pack');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') publish = true;
    else if (arg === '--tag') {
      tag = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--build') {
      build = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;
    } else fail(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(build) || build < 1) fail('--build must be a positive integer');
  return { publish, tag, build, out };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`);
  return result.stdout ?? '';
}

const options = parseArgs(process.argv.slice(2));
const version = `${BASE_VERSION}-test.${options.build}`;
if (PACKAGE_NAME === FORBIDDEN_NAME) fail(`refusing to publish ${FORBIDDEN_NAME}`);

run('pnpm', ['-s', 'build']);

const stage = join(options.out, 'rizz-test-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
const outfile = join(stage, 'bin', 'rizz.js');
await build({
  entryPoints: [join(root, 'packages', 'cli', 'dist', 'index.js')],
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
if (manifest.name === FORBIDDEN_NAME) fail(`refusing to publish ${FORBIDDEN_NAME}`);
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(options.out, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', options.out, '--json'], {
  cwd: stage,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const info = JSON.parse(packed);
const filename = Array.isArray(info) ? info[0]?.filename : info.filename;
if (typeof filename !== 'string' || filename === '') fail('npm pack did not report a filename');
const tarball = join(options.out, filename);
const packedManifest = run('tar', ['-xOf', tarball, 'package/package.json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const packedJson = JSON.parse(packedManifest);
if (packedJson.name === FORBIDDEN_NAME) fail(`tarball is named ${FORBIDDEN_NAME}`);
if (packedJson.name !== PACKAGE_NAME) fail(`tarball name is ${packedJson.name}`);
if (packedJson.version !== version) fail(`tarball version is ${packedJson.version}`);
const dependencies = packedJson.dependencies ?? {};
for (const name of Object.keys(dependencies)) {
  if (name.startsWith('@valoir/')) fail(`tarball still depends on ${name}`);
}

process.stdout.write(`tarball: ${tarball}\n`);

if (!options.publish) process.exit(0);
if (options.tag !== 'test') fail('refusing to publish without --tag test');
if (process.env.NPM_TOKEN === undefined || process.env.NPM_TOKEN === '') {
  fail('NPM_TOKEN is not set; refusing to publish');
}
const npmrc = join(options.out, 'npmrc-test-publish');
writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`);
run('npm', ['publish', tarball, '--access', 'public', '--tag', 'test', '--userconfig', npmrc]);
rmSync(npmrc, { force: true });
