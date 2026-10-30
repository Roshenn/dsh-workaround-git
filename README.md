# dsh-workaround-git

DeepSeek Harness (dsh) plugin: batch git operations across every repo in a workspace — one status table, one sync, one commit per repo's own diff, one push.

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.3-4B32C3?style=flat-square" alt="dsh engines">
  <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/tools-5-black?style=flat-square" alt="Tools">
</p>

[简体中文](./README.zh-CN.md)

## Why

Parallel development across a workspace with several projects means the same five git commands, N times, in N terminals. The model can run them one at a time — slowly, with no idea what the other repos are doing, and no single place where the batch result lands.

This plugin gives the model five verbs that operate on the whole workspace at once, and returns one table per verb: what changed, what moved, what failed and why.

## Features

- **Discovery, not configuration.** Every `.git` under the workspace root is a project. No repo list to maintain, no config file to drift.
- **One view of everything.** Branch, working-tree dirt, ahead/behind vs upstream, and last commit in a single table.
- **Sync that refuses to guess.** Fetches, then fast-forwards; a repo with a dirty working tree is skipped and reported instead of half-resolving a conflict.
- **One commit message per repo.** `git_workspace_changes` hands the model each repo's own diff; `git_workspace_commit` takes a map of repo → message, so a workspace-wide commit never reuses one message.
- **Partial success is normal.** A failed repo is a row in the table, not an aborted batch.
- **Dry run before write.** `sync`, `commit`, and `push` all accept `dryRun`.
- **Zero dependencies, zero build.** Plain ESM, no `npm install` needed to load it.

## Tools

| Tool | What it does | Key arguments |
| --- | --- | --- |
| `git_workspace_status` | Table of every repo: branch, dirt, ahead/behind, last commit | `root?`, `maxDepth?` |
| `git_workspace_sync` | `fetch` + fast-forward each repo; dirty trees are skipped | `root?`, `maxDepth?`, `mode?`, `dryRun?` |
| `git_workspace_changes` | Per-repo diff digest for writing commit messages | `root?`, `maxDepth?` |
| `git_workspace_commit` | Commit repos in one call, each with its own message | `messages` (required), `root?`, `maxDepth?`, `dryRun?` |
| `git_workspace_push` | Push each repo's branch; sets upstream on first push | `root?`, `maxDepth?`, `dryRun?` |

`root` defaults to the calling session's workspace, then to the process working directory.

## Install

Requires Node `^22.19.0 || >=24.0.0`, dsh `>= 0.2.1-rc.3`, and `git` on `PATH`.

```bash
# from a local checkout (works today)
dsh plugin --profile web add /path/to/dsh-workaround-git

# from GitHub, after the repo is pushed
dsh plugin --profile web add github:<owner>/dsh-workaround-git#v0.1.0

# from npm, once published
npx -y @deepseek-ai/dsh plugin --profile web add dsh-workaround-git@0.1.0
```

Then restart `dsh web`. `dsh plugin` forwards to pnpm against the profile's `package.json`; the package's `dsh.bundle.patch` mounts `cordis.patch.yml`, which inserts the plugin row.

Verify the row landed:

```bash
dsh --profile web --dump-config | grep workaround-git
```

**Desktop app:** the `desktop` profile is managed by the Electron shell and the CLI refuses it. Open **Plugins → Add plugin** in the app instead.

## Configure

Defaults live in `cordis.patch.yml` and can be edited there:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxDepth` | `3` | How deep to descend under the root looking for `.git` |
| `concurrency` | `4` | Repos processed in parallel |
| `pullMode` | `ff-only` | Default integration for `git_workspace_sync`: `ff-only`, `rebase`, or `merge` |
| `allowOutsideRoot` | `false` | Allow a `root` outside the session workspace (see [Safety boundaries](#safety-boundaries)) |

The patch loader replaces `config` wholesale, never deep-merges — restate every field you need.

## Usage

You do not call the tools yourself; you ask in chat and the model picks them.

**Where am I?**
> What do the repos in this workspace look like right now?

**Catch up before starting work:**
> Sync everything that is safe to sync, then tell me which repos were skipped and why.

**The two-step commit:**
> Look at what changed in each repo, write a commit message per repo from its own diff, then commit.

The model calls `git_workspace_changes`, reads each repo's files and line counts, writes one message per repo, and passes them back as a map:

```json
{
  "messages": {
    "api-server": "fix(auth): refresh token before expiry instead of after",
    "web-client": "feat(settings): move account section above billing"
  }
}
```

A repo with no entry in `messages` is skipped — never committed with someone else's message. Keys must be the exact label shown by `git_workspace_changes` (or an absolute path); a bare directory name is not enough once labels nest (`apps/api-server` and `libs/api-server` both end in `api-server`), and an unmatched key fails the call instead of being dropped.

**Push the batch:**
> Push every repo you just committed.

## Example output

`git_workspace_sync` on a five-repo workspace, dry run — it fetches so the preview is accurate, then stops before integrating:

```
**sync** · 5 repos · up-to-date: 3, would-sync: 1, skipped: 1

| repo | action | status | after | detail |
| --- | --- | --- | --- | --- |
| app | up-to-date | ok | ↑0 ↓0 | already up to date |
| app-ahead | up-to-date | ok | ↑1 ↓0 | already up to date |
| app-behind | would-sync | ok | ↑0 ↓1 | — |
| app-dirty | skipped | skipped | ↑0 ↓0 | working tree is dirty (0 staged, 1 modified, 1 untracked) |
| app-nested/deep | up-to-date | ok | ↑0 ↓0 | already up to date |
```

## What it will not do

- **No force push, no `reset --hard`, no history rewrite on its own.** Sync fetches, then integrates with `--ff-only` unless you ask for `mode: 'rebase'` or `'merge'`; `push` is a plain `git push`.
- **No commit without a message.** `messages` is required, every value must be a non-empty string, and a key that matches no repo label is reported as an error rather than silently ignored.
- **No syncing a dirty repo.** A repo with staged, modified, untracked, or conflicted files is skipped with the reason, because a conflict resolved wrongly in ten repos at once is worse than one repo left for you. A skip is reported, not counted as a failure.
- **No bare repos.** Discovery looks for a `.git` directory or worktree file; bare remotes on disk are ignored, and `node_modules`, `dist`, `build`, `target`, `.venv`, and dot-directories are skipped. Submodules do carry a `.git` file, so they show up as their own repos.
- **No partial staging.** `git_workspace_commit` stages everything (`git add --all`) in each committed repo.
- **No credentials handling.** Authentication is whatever your `git` already has configured; `GIT_TERMINAL_PROMPT` is disabled so a missing credential fails fast instead of hanging.

### Safety boundaries

`root` is model-generated, and every operation runs `git` in that directory. It is therefore confined to the calling session's workspace: a `root` outside it is refused before any `git` process starts. A deliberate wider scan requires `allowOutsideRoot: true` in the plugin config.

Reads (`status`, `changes`) never write. `sync`, `commit`, and `push` accept `dryRun`; the sync preview still fetches, because a preview that cannot see upstream commits would report the wrong thing — it never integrates, resets, or writes to a working tree.

## How it works

```
lib/index.js    cordis plugin: exports name / inject / apply, registers five tools
lib/git.mjs     git primitives: discovery, status, sync, changes, commit, push
lib/format.mjs  markdown rendering of each batch result
```

Discovery walks the root depth-first to `maxDepth`, treating every directory with a `.git` entry as a project, and keeps walking inside it (worktrees, nested projects); a hard cap of 200 repos stops a wrong root from turning into an unbounded scan. Status is parsed from `git status --porcelain=v2 --branch`, so ahead/behind come from the repo's own view of its upstream.

Every per-repo operation resolves with a result object and never rejects: the plugin reports partial failure instead of throwing away the whole batch.

## Development

```bash
node --test                                # 22 tests against real git repos in a temp workspace
node scripts/smoke.mjs                     # print the status table, a sync dry run, and the change digest

# optional: prove the schemas compile under the real tool registry, not the test stub
npm i --no-save @deepseek-ai/dsh-tools && node scripts/validate-schema.mjs
```

No install step: there are no runtime dependencies. `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` are peer dependencies supplied by the harness; the plugin test stubs the former through a loader hook.

## Compatibility

| | |
| --- | --- |
| dsh | `>= 0.2.1-rc.3` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Platforms | Windows, macOS, Linux (anywhere `git` runs) |
| Host kind | tools-only plugin — no browser half, no `dsh.client` entry |

## License

[MIT](./LICENSE)
