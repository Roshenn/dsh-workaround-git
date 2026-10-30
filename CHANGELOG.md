# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Client half (`lib/client.js`, no build step): left-sidebar entry (`sidebar.panellist`, order 45) plus a main-area page registered through `main`.
- First-run workspace picker: every dsh workspace classified as `git` / `contains` / `none`; the selection is stored in `$DSH_HOME/workaround-git/managed.json`.
- Workbench: one horizontal strip of vertical repo cards — four visible on a wide pane, extra cards scroll sideways (wheel, trackpad, ‹ › edge buttons); fixed-height card anatomy keeps the file list, message box and action buttons on one horizontal line per row.
- Per-repo panel actions: stage & AI-draft, commit, sync, push.
- VS Code-style card: commit box on top with a model button (✦) and a split commit / commit-and-push button, collapsible staged / changes / conflicts sections with per-file status, name, directory and line counts.
- File-level actions: per-row hover stage / unstage / discard (confirmation required), stage-all / unstage-all, stash, context menu with open file, reveal in file manager, copy path, copy relative path, add to `.gitignore` (file / extension / directory), view diff and file history.
- Unified diff drawer and file-history drawer; local branch menu using `git switch`.
- Each card shows its `origin` remote URL (fallback: first remote) in a small aligned line under the repository name; a URL that does not fit scrolls horizontally on hover without taking extra height.
- Opening the panel (and 刷新) fetches every managed repository; repos behind their upstream show an amber `↓N 可更新` badge plus a header count, while fetch failures surface as a small warning instead of blocking the panel.
- Per-card `↓` pull (fetch + ff-only) and `↑` push buttons left of the branch chip.
- Batch bar in the header: 批量拉取 / 批量推送 / 批量生成提交信息 across every managed repo; the result line reports success / skipped / failed counts, and batch-generated drafts fill each card's commit box.
- Per-card terminal button (`>_` right of the branch chip) and `POST /api/terminal`: opens Windows Terminal when installed, otherwise PowerShell, at the repository directory (`open -a Terminal` on macOS, `x-terminal-emulator` on Linux). The path is passed as the working directory / a single argv element, never interpolated into a shell string.
- AI commit-message drafts through dsh's own `llm` service, budgeted to 120 KB of diff and 45 s per call; the draft lands in the input box and is never auto-committed.
- HTTP API under `/workaround-git/api`; repo paths are confined to managed workspace roots.
- View toggle (grid / list) remembered in `localStorage` (`wg-view`).
- `scripts/smoke-panel.mjs` — end-to-end check of the API against a temp repo with a fake model.

### Changed

- Workspace grouping was removed from the workbench body; each card header carries the workspace name instead (hidden when it equals the repo label).
- The card structure now follows VS Code's source-control layout (commit box on top, staged / changes sections below); `/api/state` returns grouped changes and `/api/stage` / `/api/unstage` accept a `paths` list.

### Fixed

- Panel API was never mounted: `ctx.get('webServer')` during `apply()` misses the service because the Loader mounts entries concurrently, so `/workaround-git/*` fell through to the SPA fallback and the panel reported `HTTP 404: response is not JSON`. The route now mounts through `ctx.inject(['webServer'], …)`.
- The page rendered the empty workbench under the error banner when the API failed; it now shows a dedicated error state with a retry button.
- Cards now fill the available pane height instead of leaving a large blank area below them: the change list is the flexible block (min 140px) and the strip/grid stretch to the viewport.
- Per-file and per-repo actions failed with `repo must be inside the managed workspace` for workspaces that are themselves a git repository (the one-project-per-workspace layout): the guard treated the workspace root as an outside path. The root is now accepted; only paths that escape the workspace are refused.
- Open / "reveal in file manager" spawned with `windowsHide: true`, which also hid the Explorer window the user was supposed to see — the process started and exited normally, so the panel reported success while nothing appeared. Windows reveal now launches `explorer.exe /select,<path>` visibly, and opening a file uses `rundll32 url.dll,FileProtocolHandler` (no console flash).
- The per-card terminal button reported success while no terminal appeared: `spawn(powershell.exe, …, { detached: true })` sets `DETACHED_PROCESS` on Windows, so the shell ran without a console window. It now tries `wt.exe -d <repo>` first, then a hidden PowerShell launcher that opens `powershell -NoExit` through `Start-Process`; a launcher that exits non-zero falls through to the next candidate. `wt.exe` is also no longer detected with `existsSync` — the WindowsApps app-execution alias is not a normal file.

## [0.3.0] - 2026-10-30

### Added

- 管理工作区 gained a 显示设置 row with a `默认每屏显示项目数` selector (1–8, default 4); the choice is stored in `localStorage` under `wg-columns` and applied immediately. The strip still shrinks the count when the pane is too narrow for a 260 px card.

## [0.2.0] - 2026-10-30

### Added

- Card state colours: a state dot in the card header and a tinted card (amber = local changes, blue = commits to pull, green = commits to push, red = conflicts) so repositories that need action stand out in the strip.
- Coloured count chips for `↑ahead` / `↓behind` / files, section count pills (staged = green, changes = amber), VS Code-style file status colours (M amber, A/U green, D red, R violet) and `+` / `−` line counts.
- Header counters: `N 个仓库可更新` and `N 个仓库待提交`; batch buttons are colour-coded (pull blue, push green, AI drafts violet).

### Changed

- The AI draft button uses the violet accent and the primary commit button darkens on hover.

## [0.1.1] - 2026-10-30

### Added

- `AGENTS.md` version policy: every commit advances the version — `feat` bumps minor, `fix` / docs / test / chore bump patch, a breaking change bumps minor while 0.x — with `package.json` and a dated `CHANGELOG.md` section landed in the same commit; tags and `npm publish` stay with the user.

## [0.1.0] - 2026-10-30

### Added

- `git_workspace_status` — one table for every repo: branch, working-tree state, ahead/behind, last commit.
- `git_workspace_sync` — per-repo `fetch` + integration (`ff-only` by default, `rebase` or `merge` optional); dirty working trees are skipped with the reason.
- `git_workspace_changes` — per-repo diff digest (files, line counts, recent commit subjects) for writing commit messages.
- `git_workspace_commit` — batch commit where every repo carries its own message from a `messages` map; repos without an entry are skipped.
- `git_workspace_push` — batch push, setting upstream on first push.
- Automatic repo discovery under the session workspace, bounded by `maxDepth` and a 200-repo cap, skipping `node_modules`, build output, and dot-directories.
- `dryRun` on `sync`, `commit`, and `push`; the sync preview still fetches so it cannot report a stale divergence.
- `root` confined to the calling session's workspace, with `allowOutsideRoot` as the explicit opt-out.
- Zero runtime dependencies, zero build step.
- `scripts/validate-schema.mjs` — optional check that every definition compiles under the real `@deepseek-ai/dsh-tools`.

[Unreleased]: https://github.com/Roshenn/dsh-workaround-git/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Roshenn/dsh-workaround-git/releases/tag/v0.1.0
