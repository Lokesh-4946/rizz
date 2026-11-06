# Crash safety (1000 trials)

Product commit: `c1d12483403461ef6795f91d67daf7a3952d7a20`
HEAD: `c1d12483403461ef6795f91d67daf7a3952d7a20`
Node: v22.23.4
CPU: Intel(R) Xeon(R) Processor (4 cores)
OS: linux 6.12.94+ x64
Filesystem of temp dir: ext4   /dev/vdc
Seed: 20261030
Events per trial: 4
Calibration syscall hits: {"spool":2,"journal":9,"offset":3,"index":12,"serve":9}

## Method

Each trial creates a new project directory and a new `RIZZ_HOME` under the temp dir. Events go through the built CLI: `node packages/cli/dist/index.js hook <host> <event>` with a `generation_id` of `seq-NNNN` in the JSON stdin. The four kill phases are chosen uniformly. `bench/killhook.so` is preloaded into the victim process only. It counts libc `write` / `writev` / `pwrite` / `fsync` / `fdatasync` / `ftruncate` / `rename` calls whose path contains the phase needle, and raises SIGKILL on a uniformly chosen hit. Half the kills happen before that syscall and half happen after it returns. Calibration measured how many such hits one clean run of the phase produces; the kill index is uniform in `1..K` for that count.

After the kill, a fresh `rizz fold` runs with no preload. Lost events are sequence ids that do not appear in parsed `%%rizz:event%%` journal lines. An event is acked when the hook process exited 0 and stderr did not contain `could not be recorded`. In-flight events are the ones whose process was SIGKILLed. Duplicates are sequence ids parsed more than once. Torn lines are journal lines that contain the event marker but do not parse, plus a parsed event line that does not end in a newline. The clean replay parses those journal events, writes them as spool JSONL into another fresh `RIZZ_HOME`, runs `rizz fold` in the same project directory, and byte-compares `BRAIN.md`.

## Counts

Kills landed: 1000/1000 (100.000%, 95% Wilson CI 99.617%–100.000%)

Acked events missing after recovery fold, all trials: 0/3768 (0.000%, 95% Wilson CI 0.000%–0.102%)
Acked events missing after recovery fold, landed kills only: 0/3768 (0.000%, 95% Wilson CI 0.000%–0.102%)
In-flight events missing, landed kills only: 72/232 (31.034%, 95% Wilson CI 25.431%–37.256%)
Trials with a duplicate sequence id, landed kills only: 0/1000 (0.000%, 95% Wilson CI 0.000%–0.383%)
Trials with a torn or unparseable journal line after fold, landed kills only: 0/1000 (0.000%, 95% Wilson CI 0.000%–0.383%)
Trials whose recovered BRAIN.md differs from the clean replay, landed kills only: 0/1000 (0.000%, 95% Wilson CI 0.000%–0.383%)
Recovery fold non-zero exits: 0
Harness errors (trial threw before the check): 0

| scenario | trials | kills landed | events sent | acked lost | inflight lost | inflight kept | duplicate extras | torn after fold | brain mismatch |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hook-spool | 232 | 232 | 928 | 0 | 72 | 160 | 0 | 0 | 0 |
| fold-journal | 270 | 270 | 1080 | 0 | 0 | 0 | 0 | 0 | 0 |
| fold-offset-index | 259 | 259 | 1036 | 0 | 0 | 0 | 0 | 0 | 0 |
| serve-fold | 239 | 239 | 956 | 0 | 0 | 0 | 0 | 0 | 0 |

Intervals are 95% Wilson score intervals on the binomial rate. Acked-loss uses acked events as the denominator. In-flight loss uses killed hook processes as the denominator (serve and fold kills have no in-flight hook). Torn, duplicate, and brain rates use trials as the denominator.

## How to read the zeros

4000 events were sent (1000 trials × 4). 232 of those were the hook process that was SIGKILLed. The other 3768 exited 0 and all 3768 were in the journal after `rizz fold`. Of the 232 killed hooks, 72 were missing and 160 were still in the journal. All 72 missing hooks were killed *before* the chosen syscall. Every kill *after* the syscall (117/117) left the event in the journal. 43 kills before the syscall also left it, which is what happens when the chosen syscall is the later `fsync` and the `write` has already returned.

No trial had a torn journal line before or after recovery fold, no duplicate sequence id, and no `BRAIN.md` mismatch. That is the result of killing on a syscall boundary. `bench/killhook.c` raises SIGKILL before the chosen libc call or after it returns. It does not stop a `write` mid-buffer. Spool and journal records are one `write` of a newline-terminated chunk, and `offset.json` / `BRAIN.md` are written to a temp file and renamed. A boundary kill therefore drops or keeps a whole record. It is not a power-fail test and it will not produce a torn line unless a record is split across more than one syscall.
