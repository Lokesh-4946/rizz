/**
 * A1 crash-safety harness.
 *
 * Each trial uses a fresh RIZZ_HOME and drives N events through the built CLI
 * (`node packages/cli/dist/index.js hook <host> <event>`). One process is
 * SIGKILLed at a random syscall boundary inside a chosen phase, via
 * bench/killhook.so. Then `rizz fold` runs and the journal is checked.
 *
 * Phases (uniform over the four):
 *   hook-spool        kill the hook process during spool append
 *   fold-journal      kill `rizz fold` during a journal append
 *   fold-offset-index kill `rizz fold` during the offset.json or BRAIN.md write
 *   serve-fold        kill `rizz serve` during a timer-triggered fold
 *
 * The kill index is uniform in 1..K, where K is the hit count from a
 * calibration run of that phase. RIZZ_KILL_WHEN is before or after that
 * syscall, each with probability 1/2. This is process-crash injection at
 * syscall boundaries, not a power failure.
 *
 * "Acked" means the hook process exited 0 and did not print
 * "could not be recorded". The hook path always exits 0 when it finishes
 * (receiveHook), including when it only managed to write a drop file.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRODUCT_COMMIT,
  assertCliBuilt,
  assertProductTree,
  brainDiff,
  compileKillhook,
  delay,
  formatRate,
  freshDir,
  killhookSo,
  machineInfo,
  mulberry32,
  pidAlive,
  readCount,
  readObserver,
  removeDir,
  replayBrain,
  repoRoot,
  runRizz,
  seqOf,
  spawnRizz,
  wilson,
} from './lib.mjs';

const ROTATION = [
  ['cursor', 'beforeSubmitPrompt'],
  ['cursor', 'postToolUse'],
  ['cursor', 'stop'],
  ['cursor', 'preCompact'],
];

const SCENARIOS = ['hook-spool', 'fold-journal', 'fold-offset-index', 'serve-fold'];

function integerArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  const raw = index === -1 ? fallback : process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

const TRIALS = integerArg('--trials', process.env.BENCH_TRIALS ?? '1000');
const EVENTS = integerArg('--events', process.env.BENCH_EVENTS ?? '4');
const SEED = integerArg('--seed', process.env.BENCH_SEED ?? '20261030');

function hookPayload(seq, host, event, project) {
  const body = {
    conversation_id: 'bench',
    session_id: 'bench',
    generation_id: seq,
    turn_id: seq,
    hook_event_name: event,
    cwd: project,
    prompt: `${seq} crash bench`,
    text: `${seq} crash bench`,
  };
  if (event === 'postToolUse') {
    body.tool_name = 'Shell';
    body.tool_use_id = seq;
    body.command = 'true';
  }
  if (event === 'stop') body.status = 'completed';
  if (event === 'preCompact') {
    body.trigger = 'auto';
    body.context_tokens = 1200;
    body.context_window_size = 128000;
    body.context_usage_percent = 10;
  }
  return JSON.stringify(body);
}

function classifyHook(seq, result) {
  const killed = result.signal === 'SIGKILL' || result.code === 137;
  const dropped = result.stderr.includes('could not be recorded');
  return {
    seq,
    code: result.code,
    signal: result.signal,
    killed,
    dropped,
    acked: result.code === 0 && result.signal === null && !killed && !dropped,
    stderr: result.stderr.slice(0, 240),
  };
}

async function sendHook(options) {
  const [host, event] = ROTATION[options.index % ROTATION.length];
  const seq = `seq-${String(options.index + 1).padStart(4, '0')}`;
  const extraEnv = options.kill === undefined ? undefined : options.kill.env;
  const result = await runRizz(['hook', host, event], {
    cwd: options.project,
    home: options.home,
    stdin: hookPayload(seq, host, event, options.project),
    preload: options.kill === undefined ? undefined : killhookSo,
    extraEnv,
  });
  return classifyHook(seq, result);
}

function killEnv(options) {
  const env = {
    RIZZ_KILL_NEEDLE: options.needle,
    RIZZ_KILL_AT: String(options.at),
    RIZZ_KILL_WHEN: options.when,
  };
  if (options.arm !== undefined) env.RIZZ_KILL_ARM = options.arm;
  if (options.countFile !== undefined) env.RIZZ_KILL_COUNT = options.countFile;
  return env;
}

function pickKill(rng, phaseCount) {
  const span = Math.max(1, phaseCount);
  return {
    at: 1 + Math.floor(rng() * span),
    when: rng() < 0.5 ? 'before' : 'after',
  };
}

async function calibratePhase(project, needle, mode) {
  const home = await freshDir('rizz-cal-home-');
  const countFile = join(home, 'hits');
  try {
    if (mode === 'hook') {
      await sendHook({ project, home, index: 0 });
      await sendHook({
        project,
        home,
        index: 1,
        kill: { env: killEnv({ needle, at: 0, when: 'before', countFile }) },
      });
      return readCount(countFile);
    }
    for (let index = 0; index < EVENTS; index += 1) {
      await sendHook({ project, home, index });
    }
    if (mode === 'fold') {
      await runRizz(['fold'], {
        cwd: project,
        home,
        preload: killhookSo,
        extraEnv: killEnv({ needle, at: 0, when: 'before', countFile }),
      });
      return readCount(countFile);
    }
    const arm = join(home, 'arm');
    const proc = spawnRizz(['serve', '--no-open'], {
      cwd: project,
      home,
      preload: killhookSo,
      extraEnv: killEnv({ needle, at: 0, when: 'before', arm, countFile }),
    });
    const pid = proc.child.pid;
    if (pid === undefined) throw new Error('serve calibration did not start');
    const started = Date.now();
    let url = false;
    while (Date.now() - started < 8000) {
      if (/http:\/\/127\.0\.0\.1:\d+/.test(proc.output().stdout)) {
        url = true;
        break;
      }
      if (!pidAlive(pid)) break;
      await delay(20);
    }
    if (!url) {
      proc.child.kill('SIGKILL');
      await proc.done.catch(() => undefined);
      throw new Error(`serve calibration failed to start\n${proc.output().stderr}`);
    }
    for (let index = 0; index < EVENTS; index += 1) {
      await sendHook({ project, home, index });
    }
    await writeFile(arm, 'go\n');
    let last = 0;
    let stableSince = Date.now();
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 8000) {
      const count = await readCount(countFile);
      if (count !== last) {
        last = count;
        stableSince = Date.now();
      } else if (last > 0 && Date.now() - stableSince > 400) {
        break;
      }
      if (!pidAlive(pid)) break;
      await delay(20);
    }
    if (pidAlive(pid)) proc.child.kill('SIGKILL');
    await proc.done.catch(() => undefined);
    return last;
  } finally {
    await removeDir(home);
  }
}

async function runServeTrial(options) {
  const arm = join(options.home, 'arm');
  const countFile = join(options.home, 'hits');
  const proc = spawnRizz(['serve', '--no-open'], {
    cwd: options.project,
    home: options.home,
    preload: killhookSo,
    extraEnv: killEnv({
      needle: '/journal/',
      at: options.kill.at,
      when: options.kill.when,
      arm,
      countFile,
    }),
  });
  const pid = proc.child.pid;
  if (pid === undefined) throw new Error('serve did not start');
  let diedDuringFold = false;
  let finished = { code: null, signal: null };
  const sent = [];
  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 8000) {
      if (/http:\/\/127\.0\.0\.1:\d+/.test(proc.output().stdout)) {
        ready = true;
        break;
      }
      if (!pidAlive(pid)) break;
      await delay(20);
    }
    if (!ready) {
      throw new Error(`serve exited before ready\n${proc.output().stderr.slice(0, 400)}`);
    }
    for (let index = 0; index < EVENTS; index += 1) {
      sent.push(await sendHook({ project: options.project, home: options.home, index }));
    }
    await writeFile(arm, 'go\n');
    const waitStarted = Date.now();
    while (pidAlive(pid) && Date.now() - waitStarted < 15000) await delay(20);
    diedDuringFold = !pidAlive(pid);
  } finally {
    if (pidAlive(pid)) proc.child.kill('SIGKILL');
    finished = await proc.done.catch(() => ({ code: null, signal: null, stdout: '', stderr: '' }));
  }
  const sigkill = finished.signal === 'SIGKILL' || finished.code === 137;
  const hits = await readCount(countFile);
  return { sent, killLanded: diedDuringFold && sigkill, hits };
}

async function oneTrial(trial, rng, calibration) {
  const scenario = SCENARIOS[Math.floor(rng() * SCENARIOS.length)] ?? 'hook-spool';
  const project = await freshDir('rizz-crash-proj-');
  const home = await freshDir('rizz-crash-home-');
  try {
    let sent = [];
    let killLanded = false;
    let kill = { at: 1, when: 'before' };
    let target = '';
    if (scenario === 'hook-spool') {
      kill = pickKill(rng, calibration.spool);
      target = 'events.jsonl';
      const victim = Math.floor(rng() * EVENTS);
      for (let index = 0; index < EVENTS; index += 1) {
        if (index !== victim) {
          sent.push(await sendHook({ project, home, index }));
          continue;
        }
        const hooked = await sendHook({
          project,
          home,
          index,
          kill: {
            env: killEnv({
              needle: 'events.jsonl',
              at: kill.at,
              when: kill.when,
              countFile: join(home, 'hits'),
            }),
          },
        });
        sent.push(hooked);
        killLanded = hooked.killed;
      }
    } else if (scenario === 'serve-fold') {
      kill = pickKill(rng, calibration.serve);
      target = 'journal';
      const served = await runServeTrial({ project, home, kill });
      sent = served.sent;
      killLanded = served.killLanded;
    } else {
      for (let index = 0; index < EVENTS; index += 1) {
        sent.push(await sendHook({ project, home, index }));
      }
      let needle = '/journal/';
      if (scenario === 'fold-offset-index') {
        needle = rng() < 0.5 ? 'offset.json' : 'BRAIN.md';
      }
      target = needle;
      let phaseCount = calibration.journal;
      if (needle === 'offset.json') phaseCount = calibration.offset;
      if (needle === 'BRAIN.md') phaseCount = calibration.index;
      kill = pickKill(rng, phaseCount);
      const folded = await runRizz(['fold'], {
        cwd: project,
        home,
        preload: killhookSo,
        extraEnv: killEnv({
          needle,
          at: kill.at,
          when: kill.when,
          countFile: join(home, 'hits'),
        }),
      });
      killLanded = folded.signal === 'SIGKILL' || folded.code === 137;
    }
    const before = await readObserver(home);
    const recovered = await runRizz(['fold'], { cwd: project, home });
    const after = await readObserver(home);
    const replay = await replayBrain(after.events, project);
    const found = new Map();
    for (const event of after.events) {
      const seq = seqOf(event);
      found.set(seq, (found.get(seq) ?? 0) + 1);
    }
    const lost = sent.filter((item) => !found.has(item.seq));
    const duplicates = [...found.entries()]
      .filter(([, count]) => count > 1)
      .map(([seq, count]) => ({ seq, count }));
    const brainMatch = after.brain === replay.brain;
    return {
      trial,
      scenario,
      target,
      killAt: kill.at,
      killWhen: kill.when,
      killLanded,
      sent: sent.length,
      acked: sent.filter((item) => item.acked).length,
      killed: sent.filter((item) => item.killed).length,
      dropped: sent.filter((item) => item.dropped).length,
      lost: lost.map((item) => item.seq),
      lostAcked: lost.filter((item) => item.acked).map((item) => item.seq),
      lostInflight: lost.filter((item) => item.killed).map((item) => item.seq),
      inflightPersisted: sent.filter((item) => item.killed && found.has(item.seq)).length,
      duplicates,
      tornBefore: before.torn.length,
      tornAfter: after.torn.length,
      tornSample: after.torn[0]?.sample ?? null,
      brainMatch,
      brainDiff: brainMatch ? null : brainDiff(after.brain, replay.brain),
      foldCode: recovered.code,
      foldStderr: recovered.code === 0 ? '' : recovered.stderr.slice(0, 300),
      journalEvents: after.events.length,
    };
  } finally {
    await removeDir(project);
    await removeDir(home);
  }
}

function sum(trials, field) {
  return trials.reduce((total, trial) => total + trial[field], 0);
}

function scenarioTable(trials) {
  const lines = [
    '| scenario | trials | kills landed | events sent | acked lost | inflight lost | inflight kept | duplicate extras | torn after fold | brain mismatch |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const scenario of SCENARIOS) {
    const rows = trials.filter((trial) => trial.scenario === scenario);
    const dupes = rows.reduce(
      (total, trial) =>
        total + trial.duplicates.reduce((inner, item) => inner + (item.count - 1), 0),
      0,
    );
    const landedKills = rows.filter((trial) => trial.killLanded).length;
    const ackedLost = rows.reduce((total, trial) => total + trial.lostAcked.length, 0);
    const inflightLost = rows.reduce((total, trial) => total + trial.lostInflight.length, 0);
    const torn = rows.filter((trial) => trial.tornAfter > 0).length;
    const mismatch = rows.filter((trial) => !trial.brainMatch).length;
    lines.push(
      `| ${scenario} | ${rows.length} | ${landedKills} | ${sum(rows, 'sent')} | ${ackedLost} | ${inflightLost} | ${sum(rows, 'inflightPersisted')} | ${dupes} | ${torn} | ${mismatch} |`,
    );
  }
  return lines.join('\n');
}

function renderMarkdown(report) {
  const machine = report.machine;
  const all = report.intervals.all;
  const landed = report.intervals.landed;
  return `# Crash safety (${report.trials.length} trials)

Product commit: \`${report.machine.commit}\`
HEAD: \`${report.machine.head}\`
Node: ${machine.node}
CPU: ${machine.cpu.model} (${machine.cpu.count} cores)
OS: ${machine.platform} ${machine.release} ${machine.arch}
Filesystem of temp dir: ${machine.filesystem}
Seed: ${report.seed}
Events per trial: ${report.eventsPerTrial}
Calibration syscall hits: ${JSON.stringify(report.calibration)}

## Method

Each trial creates a new project directory and a new \`RIZZ_HOME\` under the temp dir. Events go through the built CLI: \`node packages/cli/dist/index.js hook <host> <event>\` with a \`generation_id\` of \`seq-NNNN\` in the JSON stdin. The four kill phases are chosen uniformly. \`bench/killhook.so\` is preloaded into the victim process only. It counts libc \`write\` / \`writev\` / \`pwrite\` / \`fsync\` / \`fdatasync\` / \`ftruncate\` / \`rename\` calls whose path contains the phase needle, and raises SIGKILL on a uniformly chosen hit. Half the kills happen before that syscall and half happen after it returns. Calibration measured how many such hits one clean run of the phase produces; the kill index is uniform in \`1..K\` for that count.

After the kill, a fresh \`rizz fold\` runs with no preload. Lost events are sequence ids that do not appear in parsed \`%%rizz:event%%\` journal lines. An event is acked when the hook process exited 0 and stderr did not contain \`could not be recorded\`. In-flight events are the ones whose process was SIGKILLed. Duplicates are sequence ids parsed more than once. Torn lines are journal lines that contain the event marker but do not parse, plus a parsed event line that does not end in a newline. The clean replay parses those journal events, writes them as spool JSONL into another fresh \`RIZZ_HOME\`, runs \`rizz fold\` in the same project directory, and byte-compares \`BRAIN.md\`.

## Counts

Kills landed: ${formatRate(report.intervals.killLanded)}

Acked events missing after recovery fold, all trials: ${formatRate(all.ackedLost)}
Acked events missing after recovery fold, landed kills only: ${formatRate(landed.ackedLost)}
In-flight events missing, landed kills only: ${formatRate(landed.inflightLost)}
Trials with a duplicate sequence id, landed kills only: ${formatRate(landed.duplicateTrials)}
Trials with a torn or unparseable journal line after fold, landed kills only: ${formatRate(landed.tornTrials)}
Trials whose recovered BRAIN.md differs from the clean replay, landed kills only: ${formatRate(landed.brainMismatch)}
Recovery fold non-zero exits: ${report.foldFailures}
Harness errors (trial threw before the check): ${report.errors}

${scenarioTable(report.trials)}

Intervals are 95% Wilson score intervals on the binomial rate. Acked-loss uses acked events as the denominator. In-flight loss uses killed hook processes as the denominator (serve and fold kills have no in-flight hook). Torn, duplicate, and brain rates use trials as the denominator.
`;
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('bench/crash.mjs requires Linux (/proc and LD_PRELOAD).');
  }
  assertCliBuilt();
  assertProductTree();
  compileKillhook();
  const project = await freshDir('rizz-cal-proj-');
  let calibration;
  try {
    calibration = {
      spool: await calibratePhase(project, 'events.jsonl', 'hook'),
      journal: await calibratePhase(project, '/journal/', 'fold'),
      offset: await calibratePhase(project, 'offset.json', 'fold'),
      index: await calibratePhase(project, 'BRAIN.md', 'fold'),
      serve: await calibratePhase(project, '/journal/', 'serve'),
    };
  } finally {
    await removeDir(project);
  }
  for (const [name, count] of Object.entries(calibration)) {
    if (count < 1) {
      throw new Error(
        `calibration hit count for ${name} was ${count}. killhook.so did not see libc writes on that path.`,
      );
    }
  }
  process.stderr.write(`crash calibration ${JSON.stringify(calibration)}\n`);
  const rng = mulberry32(SEED);
  const trials = [];
  const machine = machineInfo();
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    try {
      trials.push(await oneTrial(trial, rng, calibration));
    } catch (error) {
      trials.push({
        trial,
        scenario: 'error',
        target: '',
        killAt: 0,
        killWhen: '',
        killLanded: false,
        sent: 0,
        acked: 0,
        killed: 0,
        dropped: 0,
        lost: [],
        lostAcked: [],
        lostInflight: [],
        inflightPersisted: 0,
        duplicates: [],
        tornBefore: 0,
        tornAfter: 0,
        tornSample: null,
        brainMatch: false,
        brainDiff: null,
        foldCode: null,
        foldStderr: error instanceof Error ? error.message.slice(0, 500) : String(error),
        journalEvents: 0,
        error: true,
      });
    }
    if (trial % 25 === 0) {
      process.stderr.write(`crash ${trial}/${TRIALS}\n`);
      await publish(trials, machine, calibration);
    }
  }
  await publish(trials, machine, calibration);
}

async function publish(trials, machine, calibration) {
  const measured = trials.filter((trial) => trial.error !== true);
  const landedRows = measured.filter((trial) => trial.killLanded);
  function rates(rows) {
    const acked = sum(rows, 'acked');
    const killed = sum(rows, 'killed');
    const ackedLost = rows.reduce((total, trial) => total + trial.lostAcked.length, 0);
    const inflightLost = rows.reduce((total, trial) => total + trial.lostInflight.length, 0);
    return {
      ackedLost: wilson(ackedLost, acked),
      inflightLost: wilson(inflightLost, killed),
      duplicateTrials: wilson(
        rows.filter((trial) => trial.duplicates.length > 0).length,
        rows.length,
      ),
      tornTrials: wilson(rows.filter((trial) => trial.tornAfter > 0).length, rows.length),
      brainMismatch: wilson(rows.filter((trial) => !trial.brainMatch).length, rows.length),
    };
  }
  const report = {
    machine,
    seed: SEED,
    trialsRequested: TRIALS,
    eventsPerTrial: EVENTS,
    calibration,
    foldFailures: measured.filter((trial) => trial.foldCode !== 0).length,
    errors: trials.filter((trial) => trial.error === true).length,
    intervals: {
      killLanded: wilson(measured.filter((trial) => trial.killLanded).length, measured.length),
      all: rates(measured),
      landed: rates(landedRows),
    },
    trials,
  };
  const outDir = join(repoRoot, 'bench/results');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'crash.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'crash.md'), renderMarkdown(report));
  process.stderr.write(`crash wrote bench/results/crash.json (${measured.length} trials)\n`);
}

await main();
