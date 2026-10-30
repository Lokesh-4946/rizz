# Overhead baseline (before)

Product commit: `c1d12483403461ef6795f91d67daf7a3952d7a20`
HEAD: `c1d12483403461ef6795f91d67daf7a3952d7a20`
Node: v22.23.4
CPU: Intel(R) Xeon(R) Processor (4 cores)
OS: linux 6.12.94+ x64
Filesystem: ext4   /dev/vdc

## Method

Hook samples: 100 after 10 discarded warmup iterations. Percentiles are nearest-rank. The no-op baseline is `node -e` reading the same stdin and exiting 0. Hook time is the full `node <built cli> hook <host> <event>` wall time, which is what a host pays. The delta is the difference of the two percentiles, not the percentile of paired differences. Each event uses its own fresh RIZZ_HOME.

Fold: for each of 5 runs, a fresh RIZZ_HOME receives a spool of N pre-normalized events (one thread, fixed timestamp) and one `rizz fold`. Throughput uses the median wall time. Spool lines are about 253 bytes each.

## Hook latency

| host | event | p50 ms | p95 ms | noop p50 | noop p95 | p50 − noop | p95 − noop |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cursor | sessionStart | 64.2 | 69.0 | 19.7 | 22.4 | 44.5 | 46.6 |
| cursor | beforeSubmitPrompt | 63.9 | 68.2 | 20.6 | 23.6 | 43.4 | 44.6 |
| cursor | afterFileEdit | 63.7 | 67.7 | 19.7 | 21.9 | 44.0 | 45.8 |
| cursor | afterShellExecution | 64.1 | 69.2 | 20.1 | 22.6 | 44.0 | 46.6 |
| cursor | postToolUse | 63.8 | 71.5 | 20.7 | 24.8 | 43.1 | 46.6 |
| cursor | subagentStart | 64.3 | 68.3 | 20.0 | 22.0 | 44.3 | 46.3 |
| cursor | subagentStop | 65.0 | 74.3 | 20.4 | 23.4 | 44.6 | 51.0 |
| cursor | afterAgentResponse | 64.7 | 71.2 | 19.8 | 23.0 | 44.9 | 48.2 |
| cursor | preCompact | 63.8 | 74.6 | 20.0 | 22.8 | 43.8 | 51.7 |
| cursor | stop | 64.5 | 68.2 | 20.1 | 23.4 | 44.4 | 44.8 |
| cursor | sessionEnd | 63.7 | 69.0 | 19.9 | 22.8 | 43.8 | 46.2 |
| codex | SessionStart | 64.6 | 69.6 | 20.0 | 22.3 | 44.6 | 47.3 |
| codex | UserPromptSubmit | 65.1 | 70.6 | 20.4 | 23.1 | 44.7 | 47.5 |
| codex | PostToolUse | 64.6 | 69.9 | 20.2 | 22.9 | 44.4 | 47.1 |
| codex | SubagentStop | 64.1 | 68.6 | 20.4 | 23.0 | 43.7 | 45.7 |
| codex | Stop | 65.3 | 70.8 | 19.9 | 22.7 | 45.4 | 48.1 |
| codex | SessionEnd | 63.7 | 69.0 | 20.1 | 22.5 | 43.6 | 46.5 |
| claude | SessionStart | 64.5 | 70.0 | 20.2 | 23.5 | 44.4 | 46.5 |
| claude | UserPromptSubmit | 64.6 | 69.4 | 20.1 | 22.3 | 44.6 | 47.1 |
| claude | PostToolUse | 65.4 | 70.6 | 20.2 | 23.2 | 45.2 | 47.4 |
| claude | Stop | 63.9 | 69.6 | 20.0 | 22.3 | 43.9 | 47.3 |

## Fold throughput

| events | median ms | events/s | run ms |
| ---: | ---: | ---: | --- |
| 100 | 809 | 123.7 | 876, 809, 812, 788, 799 |
| 1000 | 10774 | 92.8 | 10723, 10802, 10840, 10774, 10648 |
| 10000 | 477532 | 20.9 | 474403, 480964, 469323, 479781, 477532 |
