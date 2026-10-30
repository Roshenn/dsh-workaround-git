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
