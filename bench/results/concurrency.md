# Concurrent hooks

Product commit: `c1d12483403461ef6795f91d67daf7a3952d7a20`
HEAD: `c1d12483403461ef6795f91d67daf7a3952d7a20`
Node: v22.23.4
CPU: Intel(R) Xeon(R) Processor (4 cores)
OS: linux 6.12.94+
Filesystem: ext4   /dev/vdc

## Method

Each round is a fresh project directory and a fresh RIZZ_HOME. The round starts `width` hook processes together. Stdin is one JSON object whose `prompt` is `seq-NNNNNN` plus 50 KiB of `b` characters. The sequence id is also `generation_id`, which `observeEventId` copies into the journal event id. After every process has exited, `rizz fold` runs once. An event is lost when its sequence id is absent from parsed journal lines.

Prompt stdin size: 51408 bytes (about 50 KB plus the JSON wrapper).

## Counts

| width | round | sent | journal | lost | lock timeouts | dropped | spool torn | pending left | max hook ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 1 | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 607 |
| 30 | 2 | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 724 |
| 30 | 3 | 30 | 30 | 0 | 0 | 0 | 0 | 0 | 550 |
| 100 | 1 | 100 | 99 | 1 | 0 | 0 | 0 | 0 | 2447 |
| 100 | 2 | 100 | 98 | 2 | 0 | 0 | 0 | 0 | 2290 |
| 100 | 3 | 100 | 99 | 1 | 0 | 0 | 0 | 0 | 2401 |

Events lost: 4/390 (1.026%, 95% Wilson CI 0.400%–2.607%)

## Where a lost event can go

These are the paths in the product code. This PR does not change them. The table above says which ones this run hit.

- `withLock` (`packages/brain/src/observe/io.ts` lines 165–193) serializes spool appends with a mkdir lock. `LOCK_WAIT_MS` is 2000 (`io.ts` line 6). A waiter past that returns `IO_FAILED` at lines 188–189.
- `appendSpoolEvent` (`packages/brain/src/observe/fold.ts` lines 293–317) appends under that lock. If the lock result is not ok, it writes `spool/pending/<sha256(id)>.json` (lines 302–303). If that write also fails, it writes `spool/drops` (lines 304–315) and still reports the hook as dropped rather than throwing.
- `receiveHook` (`packages/brain/src/observe/receive.ts` lines 109–117) returns exit code 0 when it returns, including when the event was only dropped. An exception that escapes it is caught in `packages/cli/src/index.ts` lines 1070–1076, which prints `rizz: fatal:` and exits 1.
- `foldSpool` skips a spool line it cannot parse (lines 205–207) and does not retry it. `applyPendingEvents` (lines 259–291) folds pending files. Drop files are only counted by `countUnrecorded` (lines 236–256). They never become journal events.

4 sequence ids were missing. Each lost hook exited 1 with `rizz: fatal: ENOTEMPTY: directory not empty, rmdir '<RIZZ_HOME>/spool/lock'`. None of them were in spool/drops, none logged a lock timeout, and no torn spool line or leftover pending file accounts for them. Root cause: `withLock` (`packages/brain/src/observe/io.ts`) removes the lock directory in two places that can overlap. The holder removes it in the `finally` at lines 177–178. A waiter that decides the lock is stale also removes it at lines 184–186. `lockIsStale` (lines 153–162) returns true when the pid file is already gone and `stat` throws (line 161), or when the directory is older than `ORPHAN_LOCK_MS` (1000ms, line 5). The waiter `rm` sits in the `catch` and is not wrapped, so `ENOTEMPTY` from `rmdir` rejects the promise instead of returning `{ ok: false }`. `appendSpoolEvent` (`packages/brain/src/observe/fold.ts` lines 298–303) writes `spool/pending` only when `withLock` returns a failed result. A thrown `ENOTEMPTY` skips that fallback. `receiveHook` does not catch it. `packages/cli/src/index.ts` lines 1070–1076 print `rizz: fatal:` and exit 1. The event is never spooled. Widths of 30 stayed under the 1000ms stale threshold and lost nothing. Widths of 100 ran past 2s and lost events. 15 other events in the 100-wide rounds were missing from the spool file but present in the journal: those took the returned-error path, landed in spool/pending, and fold applied them. Lock-timeout stderr lines: 0. Drop stderr lines: 0. Torn spool lines: 0. Pending files left after fold: 0.
