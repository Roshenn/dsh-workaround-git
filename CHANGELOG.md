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

## [0.6.0] - 2026-11-03

### Added

- Conflict lane, host and panel: `repoStatus` reports the in-progress operation (`sequencer`: merge / rebase / cherry-pick / revert) and the unmerged file names, not just a count.
- `git_workspace_conflicts` (new tool): `list` the operation and its files, resolve with `ours` / `theirs` / `stage`, then `continue` or `abort` (`abort` requires `confirm: true`; `dryRun` lists what would be lost).
- `git_workspace_stage` and `git_workspace_restore` (new tools): file-level stage/unstage, and discard/stash with an explicit `confirm: true` for the irreversible one.
- `git_workspace_commit` gains `stagedOnly` and a per-repo `paths` map: commit the index as it is, or stage and commit only the listed files (`git commit --only`), leaving other staged work in place.
- Panel conflict actions: conflict rows lead with 用 Ours 解决 / 用 Theirs 解决 / 标记为已解决; an operation in progress shows a badge with 中止… and 继续; a fully resolved merge's commit button becomes `✓ 完成合并并提交` and sends `allowSequencer: true`.
- Panel live refresh: 10 s poll while the page is visible and the batch bar idle, immediate refresh on window focus / tab-again (2 s throttle), quiet poll failures, a `最近更新 HH:MM:SS` stamp, and a reentrancy guard on card actions.
- `POST /api/resolve` and `POST /api/sequencer`; `/api/commit` accepts `allowSequencer`.

### Changed

- `commitRepo` refuses to commit while a merge / rebase / cherry-pick / revert is in progress unless `allowSequencer` is set, so a batch commit can no longer conclude a merge by accident. A merge resolved to exactly the target side leaves a clean tree; that case used to report `nothing-to-commit` and made the merge commit impossible.
- `git_workspace_status` names the conflicted files and marks the current operation; `/api/commit` answers 409 for `conflict` and `sequencer-active` instead of a generic 500.
- Panel and API containment checks resolve symlinks/junctions: a junction inside a managed workspace that points elsewhere is refused instead of running git outside the workspace.

### Fixed

- Panel conflict rows always showed 文件历史 because the guard compared against `'conflict'` while the section key is `'conflicts'`.

## [0.6.1] - 2026-11-03

### Added

- `repoSnapshot` and `parsePorcelainV2Z` in `lib/git.mjs`: one snapshot per card now answers what `repoStatus` + `repoChangeList` + `repoRemote` + `repoRootAt` answered in three sequential waves. A parity test pins it against the old primitives, including a stopped merge and its conflicted files.
- `scripts/bench-panel.mjs` — measures the panel entry path on this machine's managed workspaces (`GET /api/managed` read, `/api/state` runs, and `--fetch` for a network probe); read-only.

### Changed

- `GET /api/state` is cheaper: one `rev-parse` (work-tree root, scope prefix, git dir), one `status --porcelain=v2 --branch -z` that supplies both the counts and the grouped file list, `log -1` and `remote get-url` all run concurrently, and the per-file numstat is skipped for a clean repository. Measured here with seven managed workspaces: 937 ms → 560–700 ms for the same six repositories. The response shape is unchanged.
- The remote URL is cached for 60 s (`repoRemote(…, { fresh: true })` bypasses the cache), so the panel's 10 s poll no longer respawns git for every card.
- `GET /api/state` reads workspace ids and titles from dsh's registry (`rawWorkspaces`) instead of probing every workspace with git; the git-probing classification stays in `/api/workspaces`, which only the picker asks for.
- `/api/fetch` runs six repositories at a time instead of four, shortening the background remote check.

## [0.5.2] - 2026-10-31

### Changed

- 面板单卡「✓ 提交」改为先 `git add --all` 再提交：提交框里有 message 时，未暂存的修改与未追踪文件一并进入暂存区，与批量「✓ 批量添加并提交」一致；按钮 `title` 说明这一行为。`/api/commit` 的 `commitRepo` 调用从 `addAll: false` 改为 `true`。

### Fixed

- `commitRepo(..., { addAll: true })` 在存在合并冲突时直接返回 `action: 'conflict'`，避免 `git add --all` 把冲突标记静默标成已解决、再提交出去。

## [0.5.1] - 2026-10-31

### Added

- `README.md` gains a **Screenshots** section: the sidebar panel (one card per repository) and the `git_workspace_status` table, captured from the running app and stored under `docs/screenshots/`. dsh's plugin market derives its catalog preview from README images, so the same two files serve there.

## [0.5.0] - 2026-10-30

### Added

- ✓ 批量添加并提交 in the batch bar: stages every pending change in each managed scope and commits it with the card's current message, so a batch suggest → batch commit flow is one click after the drafts exist.
- `POST /api/batch` action `commit`: takes a `messages` map keyed by absolute repo path, stages what is pending, and commits per repo. Repos without a message, with merge conflicts, or with nothing pending are reported separately instead of being committed with an empty or borrowed message.

### Changed

- Card commit messages now live in the page state instead of each card, so the batch commit sends exactly what the inputs show (manual edits included) and clears the message only for repos it actually committed.
- The batch button stays grey until every repo with pending changes has a non-empty message; its tooltip names the reason.

## [0.4.0] - 2026-10-30

### Added

- A workspace that is a subdirectory of a git repository is now a valid scoped workspace: classification asks git for the work-tree root (`rev-parse --show-toplevel`) instead of looking for `.git`, so a module directory of a large repository can be managed on its own. Its card reports only that directory's branch state, changes and line counts, and the same rule applies to `git_workspace_*` when the session workspace is such a subdirectory.
- Managing a repository root and a module inside it side by side is allowed: card identity is (repository root, scope), so the two scopes coexist while the same pair discovered twice — a nested repository also managed on its own — still collapses to one card.

### Changed

- `discoverRepos` includes the start directory when it sits inside a work tree, and the scoped primitives (`status`, change list, numstat, draft digests, diff) run with a `.` pathspec so they never report files outside the scope.

### Fixed

- Committing from a scoped workspace refuses with `scope-conflict` when the shared index holds changes staged outside the module, instead of sweeping another module's work into the commit; stage-all and stash-all stay inside the scope too.

## [0.3.2] - 2026-10-30

### Fixed

- One physical repository rendered twice in the panel: a managed workspace can itself be a git repository and contain other managed repositories (`~/.dsh` holds `dsh-looptree-dashboard`, `dsh-remote-ctx` and `dsh-workaround-git`). `/api/state` reported the nested repos once per workspace, so seven cards stood for four repositories and the header counters doubled. A repo that is its own managed root now owns itself and is otherwise owned by the closest ancestor workspace; `managedWorkspacesState` and `managedRepoRefs` (batch pull / push / AI drafts) share that rule, so batch actions no longer run twice on one repo.

## [0.3.1] - 2026-10-30

### Fixed

- Test fixtures now pin `pull.rebase=false` through `GIT_CONFIG_*`: with a global `pull.rebase=true`, the `git pull --ff-only` calls tried to rebase and the dirty fixture repo made them fail, so `core.test.mjs` and `plugin.test.mjs` aborted with `cannot pull with rebase`.

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
