# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-30

### Added

- `git_workspace_status` — one table for every repo: branch, working-tree state, ahead/behind, last commit.
- `git_workspace_sync` — per-repo `fetch` + integration (`ff-only` by default, `rebase` or `merge` optional); dirty working trees are skipped with the reason.
- `git_workspace_changes` — per-repo diff digest (files, line counts, recent commit subjects) for writing commit messages.
- `git_workspace_commit` — batch commit where every repo carries its own message from a `messages` map; repos without an entry are skipped.
- `git_workspace_push` — batch push, setting upstream on first push.
- Automatic repo discovery under the session workspace, bounded by `maxDepth` and skipping `node_modules`, build output, and dot-directories.
- `dryRun` on `sync`, `commit`, and `push`.
- Zero runtime dependencies, zero build step.

[Unreleased]: https://github.com/<owner>/dsh-workaround-git/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<owner>/dsh-workaround-git/releases/tag/v0.1.0
