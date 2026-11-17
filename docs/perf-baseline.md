# Panel performance baseline

What the panel's entry path, per-action path and background work actually cost
on this machine — measured instead of guessed. Every command below writes
nothing to any repository, so re-running them after a change is safe and is the
point: compare the `after` column, not a feeling.

Captured **2026-11-17** against **0.12.0** (before the per-repository read work).

## Environment

| | |
| --- | --- |
| Machine | Apple M3 Max, macOS 14.8.5 |
| Node | v24.14.0 |
| Panel | 8 managed workspaces, 7 cards, 1 hidden card |
| Load average | **12–18** during this capture (`ffmpeg`, `replayd`, Chrome at 100 %+ CPU) |

**The absolute numbers are inflated, p95 more than p50.** The same
`/api/state` read on a quieter moment of the same machine was 189–304 ms; this
capture is 225–332 ms. Read the *composition* (spawn counts, where the wait
goes) as stable, and treat every millisecond here as an upper bound. Record
`uptime` with any future capture, or the comparison is meaningless.

## Reproduce

```bash
node scripts/bench-panel.mjs --runs=5 --json > /tmp/wg-state.json
node scripts/bench-panel.mjs --breakdown --runs=1 --json > /tmp/wg-breakdown.json
node scripts/bench-panel.mjs --http --runs=8            # live API, GET only
```

`--breakdown` adds discovery per workspace plus one snapshot and one
per-command breakdown per repository; `--http` measures the running panel API
(`--base=` or `$DSH_WEB_URL`). Both are read-only. `--json` is the format to
diff between captures.

## 1. Entry path

| Request | p50 | p95 | max | Payload | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /api/managed` | 1.8 ms | 6.2 ms | 6.2 ms | 1.3 kB | one store read |
| `GET /api/state` (live API) | 239 ms | 286 ms | 286 ms | 6.6 kB | discovery + one snapshot per repository |
| `GET /api/state` (local, 5 runs) | 277 ms | 332 ms | 332 ms | 6.5 kB | 45 `git` spawns |
| `GET /api/state` first run | — | — | 332 ms | 6.5 kB | 53 spawns: cold remote cache |

The payload is about 6.6 kB. **Payload is not the cost — 45 `git` processes for 7
cards is.** `/api/managed` is three orders of magnitude cheaper, which is why it
can drive the first paint.

Payload tracks how many files are dirty, not how many cards exist: the same read
right after committing this repository is 6.1 kB. Compare payload sizes only
between captures with the same working tree.

## 2. Where the cost goes

Discovery, per workspace (parallel, depth 2):

| Workspace | Discover | Repos found | Cards |
| --- | --- | --- | --- |
| `.dsh` | 233 ms | 4 | 3 |
| `demand-collection` | 126 ms | 1 | 1 |
| `story-weft` | 42 ms | 1 | 1 |
| `dsh-remote-ctx` | 36 ms | 1 | 1 |
| `demo-animation-producer` | 33 ms | 1 | 1 |
| `dsh-looptree-dashboard` | 33 ms | 1 | 1 |
| `english-chunk` | 20 ms | 1 | 1 |
| `dsh-workaround-git` | 19 ms | 1 | 1 |

Snapshot, per repository (3–5 spawns each; the walk costs a spawn too):

| Repository | Snapshot | Spawns | Dirty |
| --- | --- | --- | --- |
| `story-weft` | 81 ms | 4 | no |
| `dsh-workaround-git` (under `.dsh`) | 83 ms | 5 | yes |
| `dsh-remote-ctx` (under `.dsh`) | 77 ms | 4 | no |
| `demo-animation-producer` | 60 ms | 5 | yes |
| `demand-collection` | 69 ms | 4 | no |
| `dsh-remote-ctx` | 53 ms | 3 | no |
| `dsh-workaround-git` | 44 ms | 4 | yes |
| `dsh-looptree-dashboard` (under `.dsh`) | 25 ms | 4 | no |
| `dsh-looptree-dashboard` | 41 ms | 3 | no |
| `english-chunk` | 32 ms | 4 | no |

Per command (same loaded machine, so these are upper bounds):

| Command | Cost | Spawns |
| --- | --- | --- |
| `rev-parse --show-toplevel --show-prefix --git-dir` | 14–45 ms | 1 |
| `status --porcelain=v2 --branch -z` | 24–67 ms | 1 |
| `log -1 --pretty=…` | 15–51 ms | 1 |
| `diff --numstat --relative HEAD` (dirty only) | 19–41 ms | 1 |
| `remote get-url` (cached, 60 s TTL) | 0 ms | 0 |
| `remote get-url` (fresh) | 14–65 ms | 2 |

## 3. Findings

- **F1 — the entry is a serial chain with nothing to show.** `loadIndex` awaits
  `/managed` and then `/state` before the first card exists; the page has one
  "读取变更…" line for the whole wait (`lib/client.js` `loadIndex`).
- **F2 — ~6.4 spawns per card.** 45 spawns for 7 cards. Discovery is one walk
  plus a `rev-parse` per workspace; a snapshot is 3–5 processes.
- **F3 — the same repository is snapshotted twice.** `.dsh` is a `contains`
  workspace that discovers `dsh-looptree-dashboard`, `dsh-remote-ctx` and
  `dsh-workaround-git`, and all three are also managed as their own workspace.
  Both copies are snapshotted and deduped only afterwards
  (`lib/state.mjs`, `dedupeScopedRows`): about **13 of the 45 spawns (≈30 %)**
  are wasted, and the three nested workspaces still pay their own discovery
  walk (19–36 ms each). **Not approved work** — see "candidates" below.
- **F4 — every action pays the full entry cost again.** `run()` ends with
  `await onChanged()` → `refreshState()` → the same `/api/state`, so staging one
  file re-reads 8 workspaces and the button spins for the whole read.
- **F5 — the background remote check holds the toolbar.** `/api/fetch` runs for
  every repository (60 s timeout each) after the panel paints; while it is in
  flight the 刷新 button is disabled and pull / push / one-click sync await it
  before they start (`fetchPromiseRef`).
- **F6 — client-side cost is unmeasured.** The code shows no skeleton, no
  `React.memo`, a new object tree on every 10 s poll, and the commit message
  living in `Page` state (every keystroke re-renders every card). The client
  column is pending the one manual pass in §5.

## 4. Thresholds

These decide what the next round is allowed to touch. Each row is a measurement
plus the item it unlocks; an item below its threshold stays out.

| # | Threshold | This capture | Verdict | Item |
| --- | --- | --- | --- | --- |
| T1 | `/api/state` p95 ≥ 120 ms | **286 ms** | **triggered** | B1 per-workspace reads |
| T2 | mount → first card ≥ 150 ms, or first skeleton frame ≥ 50 ms | not captured | pending | B2 skeleton + snapshot cache |
| T3 | click → idle p95 ≥ 200 ms, or idle time ≥ 50 % spent re-reading | not captured (code path: full `/state` per action, ≈ 239 ms) | pending — mechanism proven | B3 single-repo read, B4 optimistic updates |
| T4 | one poll with no changes still re-renders ≥ 1 card, or poll task ≥ 30 ms | not captured | pending | B5 memo + structural sharing |
| T5 | ≥ 1 long task > 50 ms while typing 20 chars or opening a diff | not captured | pending | B6 input isolation + diff virtualization |
| T6 | background fetch → one-click sync start ≥ 500 ms | not captured (code path: awaits the whole fetch) | pending — mechanism proven | B7 fetch coalescing, drop the global wait |
| T7 | one snapshot ≥ 100 ms, or `/api/state` spawns ≥ 5 × repos | 25–83 ms; **45 ≥ 35** | **spawn clause triggered** | F3 claim-before-snapshot (candidate); numstat cap stays optional |

## 5. Client baseline (pending one manual pass)

The panel runs behind the desktop app's authenticated page, so this half needs
one pass in the open GUI (about 30 seconds):

1. In the panel's DevTools console: `localStorage.setItem('wg-perf','1')`, then reload.
2. Open 工作区 Git and wait for the first card.
3. Click 刷新 once; click one file's `＋` (stage) once.
4. Type 20 characters into a card's commit box.
5. Open the diff of the file with the most changes, scroll to the bottom.
6. `copy(__wgPerfReport())` and paste the result into a capture file
   (`/tmp/wg-client-before.json`).

Turn it off with `localStorage.removeItem('wg-perf')` and a reload. With the
flag off nothing is recorded and `__wgPerfReport()` answers
`{ enabled: false, hint }`.

Recorded span names (all milliseconds, p50/p95/max per name):

| Span | Meaning |
| --- | --- |
| `entry:managed` | `/managed` round trip |
| `entry:state` | `/state` round trip |
| `mount:firstCard` | panel mount → first card painted |
| `state:firstCard` | `/state` returned → first card painted (the render cost) |
| `action:<name>:response` | click → action request returned |
| `action:<name>:refresh` | the full `/state` reload after the action |
| `action:<name>:idle` | click → spinner cleared (what the user waits) |
| `state:reload` / `state:skip` | background poll or focus refresh; `detail.reason` says which |
| `diff:fetch` / `diff:render` | request → text → drawer painted |
| `longTasks` | count / max / last 20 over 50 ms |

## 6. After

Filled in by the next round, same commands, same machine, load reported.

| Metric | Before | After |
| --- | --- | --- |
| `/api/state` p95 (live) | 286 ms | — |
| `/api/state` git spawns | 45 | — |
| `mount:firstCard` p95 | pending | — |
| `action:*:idle` p95 | pending | — |
| long tasks while typing | pending | — |
| long tasks opening a diff | pending | — |

## Candidates (measured, not approved)

- **F3 fix — claim before snapshot.** Skip a discovered repository when another
  managed workspace's own path *is* that repository, instead of snapshotting it
  twice and deduping afterwards. ~25 % of the entry cost, ~15 lines in
  `lib/state.mjs`, no API change. Worth doing before B1, because B1 multiplies
  the same duplicate work across the per-workspace requests.
