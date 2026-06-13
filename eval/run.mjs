#!/usr/bin/env node
// rizz eval harness (brief §4.6, M5). Runs the coding-task suite against the loop and reports
// pass/score/tokens/cost. M0 ships the runner skeleton + schema so CI has a real, green eval
// step to build on; the loop-backed tasks land in M5.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tasksDir = join(dirname(fileURLToPath(import.meta.url)), 'tasks');

/** Load every *.task.json under eval/tasks. */
function loadTasks() {
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith('.task.json'))
    .map((f) => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')));
}

const tasks = loadTasks();
console.log(`rizz eval — ${tasks.length} task(s) loaded`);

let passed = 0;
for (const task of tasks) {
  // M5: drive the loop here and score the result. For now we validate the task schema so the
  // suite is real and the harness is wired into CI.
  const valid = typeof task.id === 'string' && typeof task.prompt === 'string';
  if (valid) passed++;
  console.log(`  ${valid ? '✓' : '✗'} ${task.id ?? '(missing id)'}`);
}

console.log(`\n${passed}/${tasks.length} task(s) valid`);
process.exit(passed === tasks.length ? 0 : 1);
