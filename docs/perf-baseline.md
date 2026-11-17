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
- **F6 — the client render is cheap; the wait is the host read.** With 7 cards
  the strip paints in **3 ms** (`state:firstCard`) and the first card lands
  165 ms after mount, of which **155 ms is `/api/state`**. Typing and a 13-line
  diff produced **zero long tasks over 50 ms**, and the diff drawer's 60 ms was
  59 ms of request. Memoization and virtualization are not justified at this
  data size; the same ~150 ms read is what makes every click feel slow (74 % of
  a stage action's 183 ms).

## 4. Thresholds

These decide what the next round is allowed to touch. Each row is a measurement
plus the item it unlocks; an item below its threshold stays out.

| # | Threshold | This capture | Verdict | Item |
| --- | --- | --- | --- | --- |
| T1 | `/api/state` p95 ≥ 120 ms | **286 ms** | **triggered** | B1 per-workspace reads |
| T2 | mount → first card ≥ 150 ms, or first skeleton frame ≥ 50 ms | **165 ms** (155 ms of it `/api/state`) | **triggered** | B2 skeleton + snapshot cache |
| T3 | click → idle p95 ≥ 200 ms, or idle time ≥ 50 % spent re-reading | 183 ms, of which 136 ms (74 %) is the reload | **triggered (share clause)** | B3 single-repo read, B4 optimistic updates |
| T4 | one poll with no changes still re-renders ≥ 1 card, or poll task ≥ 30 ms | render is 3 ms per full state; no long task recorded | **not triggered** (park B5 until 30+ cards) | B5 memo + structural sharing |
| T5 | ≥ 1 long task > 50 ms while typing 20 chars or opening a diff | **0 long tasks**; diff was 13 lines (1 ms render) | **not triggered** (park B6; re-test with a 5k-line diff) | B6 input isolation + diff virtualization |
| T6 | background fetch → one-click sync start ≥ 500 ms | not exercised in this run | **still open** | B7 fetch coalescing, drop the global wait |
| T7 | one snapshot ≥ 100 ms, or `/api/state` spawns ≥ 5 × repos | 25–83 ms; **45 ≥ 35** | **spawn clause triggered** | F3 claim-before-snapshot (candidate); numstat cap stays optional |

## 5. Client baseline

Captured **2026-11-17 22:09**, **0.13.0**, 7 cards, from the panel's own 性能
button (`perf-report.json`, `pluginVersion` stamped). The machine was idle this
time, so these numbers are trustworthy rather than upper bounds.

| span | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `state:reload` | 8 | 150 | 210 | 210 |
| `action:stage:idle` | 1 | 183 | 183 | 183 |
| `mount:firstCard` | 1 | 165 | 165 | 165 |
| `entry:state` | 1 | 155 | 155 | 155 |
| `action:stage:refresh` | 1 | 136 | 136 | 136 |
| `diff:render` | 1 | 60 | 60 | 60 |
| `diff:fetch` | 1 | 59 | 59 | 59 |
| `action:stage:response` | 1 | 47 | 47 | 47 |
| `entry:managed` | 1 | 5 | 5 | 5 |
| `state:firstCard` | 1 | 3 | 3 | 3 |

The sequence in `recent` tells the story in order: mount → `/managed` 5 ms →
`/state` 155 ms → first card 165 ms; then the panel re-read **everything** four
more times without being asked (two `after-fetch` reloads at 210 ms and 148 ms,
a poll at 151 ms), a stage click took 47 ms + 136 ms reload = **183 ms of
spinner**, and the diff drawer spent 59 ms of its 60 ms waiting for the patch.

Three conclusions:

1. **The client is fast.** Painting seven cards costs 3 ms; no long task was
   recorded while typing or opening the drawer.
2. **One request is the whole cost.** 155 of 165 ms at entry, 136 of 183 ms per
   action, and ~150 ms on every 10 s poll — the same `/api/state`.
3. **Optimistic updates are worth it** for stage/unstage: the round trip is
   47 ms, so the 136 ms reload is the only reason a click is not instant.

Reading the run: **⏱ 性能** → four interactions → **■ 结束测量** → the dialog
shows the table and saves `$DSH_HOME/workaround-git/perf-report.json`. The four
entry spans are recorded even while the button is idle (four timestamps per
mount), so a run started minutes after the panel opened still reports first
paint; everything else only records between start and stop.
`localStorage['wg-perf']='1'` remains a console escape hatch.

## 6. After

Filled in by the next round, same commands, same machine, load reported.

| Metric | Before | After |
| --- | --- | --- |
| `/api/state` p95 (live, loaded machine) | 286 ms | — |
| `/api/state` git spawns | 45 | — |
| `mount:firstCard` | 165 ms | — |
| `action:stage:idle` | 183 ms | — |
| `action:stage:refresh` | 136 ms | — |
| `state:firstCard` (render) | 3 ms | — |
| long tasks while typing / opening a diff | 0 | — |

## Candidates (measured, not approved)

- **F3 fix — claim before snapshot.** Skip a discovered repository when another
  managed workspace's own path *is* that repository, instead of snapshotting it
  twice and deduping afterwards. ~25 % of the entry cost, ~15 lines in
  `lib/state.mjs`, no API change. Worth doing before B1, because B1 multiplies
  the same duplicate work across the per-workspace requests.
