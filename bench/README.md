# Observer measurement harness

Benchmarks for the Rizz observer. They shell out to the built CLI (`packages/cli/dist/index.js`). They do not change product code.

The product tree under test is `dev` at `c1d12483403461ef6795f91d67daf7a3952d7a20` (merge of PR #198). Every result file records that SHA as `commit`.

```bash
pnpm build
node bench/crash.mjs --trials 1000 --events 4 --seed 20261030
node bench/concurrency.mjs
BENCH_SAMPLES=100 BENCH_WARMUP=10 node bench/overhead.mjs
```

`crash.mjs` is Linux-only. It compiles `bench/killhook.c` into `bench/killhook.so` and preloads it into the victim process. Outputs land in `bench/results/`.

| Script | Question |
| --- | --- |
| `crash.mjs` | After SIGKILL during spool append, journal append, offset/index write, or the serve fold timer, does `rizz fold` lose acked events, duplicate them, leave a torn journal line, or rebuild a different `BRAIN.md`? |
| `concurrency.mjs` | Do 30 and 100 simultaneous ~50 KB hooks, three rounds each, lose sequence ids? |
| `overhead.mjs` | Hook p50/p95 against a no-op Node process, and fold throughput at 100, 1k, and 10k events (median of 5). |
| `token-coverage.md` | Which Cursor, Codex CLI, and Claude Code hook events carry token-usage fields. |

Token-coverage payloads are in `bench/payloads/`. `captured` files are hook stdin from this VM. `synthetic` and `staff-reported` files are not.
