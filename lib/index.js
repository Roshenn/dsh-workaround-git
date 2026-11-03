/**
 * dsh-workaround-git — batch git operations across every repo in a DSH workspace.
 *
 * Host half of a DeepSeek Harness plugin: registers eight model-facing tools over
 * the `tools` service and resolves the session workspace through `workingDirectory`.
 *
 * Design contract enforced here:
 *   - reads are cheap and always safe (status / changes)
 *   - writes take an explicit dry-run switch and never span repos with one message
 *   - a failing repo is reported, never allowed to abort the batch
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  applyFiles,
  changesAll,
  commitAll,
  discoverRepos,
  pushAll,
  repoLabel,
  repoStatus,
  resolveConflict,
  sequencerAction,
  statusAll,
  syncAll,
} from './git.mjs';
import { formatChanges, formatCommit, formatConflicts, formatFiles, formatPush, formatStatus, formatSync } from './format.mjs';
import { API_PREFIX, createApiHandler } from './api.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-workaround-git';
/** Services required: the tool registry and session directory resolution. */
export const inject = ['tools', 'workingDirectory'];

const DEFAULTS = {
  maxDepth: 3,
  concurrency: 4,
  pullMode: 'ff-only',
  allowOutsideRoot: false,
};

const SYNC_MODES = ['ff-only', 'rebase', 'merge'];

function configOf(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    maxDepth: Number.isInteger(value.maxDepth) && value.maxDepth >= 0 ? value.maxDepth : DEFAULTS.maxDepth,
    concurrency: Number.isInteger(value.concurrency) && value.concurrency > 0 ? value.concurrency : DEFAULTS.concurrency,
    pullMode: SYNC_MODES.includes(value.pullMode) ? value.pullMode : DEFAULTS.pullMode,
    allowOutsideRoot: value.allowOutsideRoot === true,
  };
}

/**
 * Resolve the batch root and keep it inside the session workspace.
 *
 * `root` reaches here from model-generated arguments, and every write runs
 * `git` in that directory — an unconfined value would let one tool call commit
 * or push anything on disk. Config `allowOutsideRoot: true` is the explicit
 * opt-out for deliberately wide scans.
 */
async function resolveRoot(ctx, exec, requested, config) {
  const sessionDir = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined;
  const base = resolve(sessionDir ?? process.cwd());
  if (typeof requested !== 'string' || !requested.trim()) return base;

  const candidate = resolve(requested.trim());
  if (config.allowOutsideRoot || candidate === base) return candidate;

  const rel = relative(base, candidate);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!inside) {
    throw new Error(
      `root must stay inside the session workspace (${base}); got ${candidate}. `
      + 'Set plugin config allowOutsideRoot: true to scan elsewhere.',
    );
  }
  return candidate;
}

/** Canonical comparison key for a repo label or absolute path. */
function normalizeKey(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Resolve one repo argument (label from git_workspace_status, or an absolute
 * path) against the discovered set. A key that matches nothing fails the call
 * instead of silently acting on zero repos.
 */
async function resolveRepoKey(root, key, { maxDepth }) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('repo is required for this action (use a label from git_workspace_status, or an absolute path)');
  }
  const repos = await discoverRepos(root, { maxDepth });
  const wanted = normalizeKey(key);
  const match = repos.find((p) => normalizeKey(repoLabel(p, root)) === wanted || normalizeKey(p) === wanted);
  if (match === undefined) {
    throw new Error(
      `repo ${key} not found under ${root}. Keys must match git_workspace_status labels exactly (or be absolute paths).`,
    );
  }
  return match;
}

/** Canonical output shape shared by every tool in this plugin. */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
      repos: { type: 'array', required: true, items: { type: 'string' } },
      ok: { type: 'boolean', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

/**
 * `ok` means "nothing failed". A repo deliberately skipped (dirty tree, no
 * message) is a reported decision, not a failure, so it must not flip the batch.
 */
function allOk(rows) {
  return rows.every((row) => row.ok !== false || row.action === 'skipped');
}

/**
 * Mount the panel API when the host exposes a web server.
 *
 * `webServer` is deliberately not in the static `inject` list: a headless host
 * must keep the eight tools without a panel. It cannot be fetched with a plain
 * `ctx.get()` either — the Loader mounts entries concurrently, so at `apply()`
 * time the web server may not exist yet and the route would never be mounted
 * (the panel then gets the SPA fallback's 404). `ctx.inject` waits for the
 * service and registers at that point; this is the same pattern the host's own
 * packages use.
 */
function mountApi(ctx) {
  const handler = createApiHandler(ctx);
  let mounted = false;

  const register = (webCtx) => {
    if (mounted) return;
    let webServer;
    try {
      webServer = webCtx?.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
    } catch {
      webServer = undefined;
    }
    if (!webServer || typeof webServer.register !== 'function') return;
    mounted = true;
    try {
      const mount = () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
      const scope = webCtx && typeof webCtx.effect === 'function' ? webCtx : ctx;
      if (typeof scope.effect === 'function') scope.effect(mount, 'dsh-workaround-git: panel api');
      else mount();
      ctx.logger?.info?.(`[workaround-git] panel api mounted at ${API_PREFIX}`);
    } catch (error) {
      mounted = false;
      ctx.logger?.warn?.('[workaround-git] panel api mount failed: ' + (error?.message || error));
    }
  };

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register);
  } catch (error) {
    ctx.logger?.warn?.('[workaround-git] panel api wiring failed: ' + (error?.message || error));
  }
  // This bundle can load after the web app: if the server is already up, mount now.
  register(ctx);
}

export function apply(ctx, rawConfig) {
  const config = configOf(rawConfig);
  mountApi(ctx);

  ctx.tools.register(defineTool({
    name: 'git_workspace_status',
    description:
      'Overview of every git repo under the workspace root: branch, working-tree dirt, ahead/behind vs upstream, last commit. '
      + 'Conflicted files are named and an in-progress merge/rebase/cherry-pick/revert is marked (`[merge]` after the branch). '
      + 'Read-only, safe to call any time. Use it first in a parallel-development session to see which repos moved.',
    parameters: {
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend while looking for repos. Default 3.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Git workspace status', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const result = await statusAll(root, { maxDepth, concurrency: config.concurrency });
      return {
        text: formatStatus(result),
        repos: result.rows.map((row) => row.repo),
        ok: allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_sync',
    description:
      'Fetch and fast-forward every repo under the workspace root. Skips repos with a dirty working tree instead of risking a half-resolved conflict, '
      + 'and reports each repo separately. Pass dryRun to preview without touching any repo.',
    parameters: {
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      mode: {
        type: 'string',
        enum: [...SYNC_MODES],
        description: "Integration mode: 'ff-only' (default), 'rebase', or 'merge'.",
      },
      dryRun: { type: 'boolean', description: 'Fetch to make the preview accurate, then report what would be integrated. Never pulls, resets, or writes.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Sync workspace repos', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const mode = SYNC_MODES.includes(args.mode) ? args.mode : config.pullMode;
      const result = await syncAll(root, {
        maxDepth,
        mode,
        dryRun: args.dryRun === true,
        concurrency: config.concurrency,
      });
      return {
        text: formatSync(result),
        repos: result.rows.map((row) => row.repo),
        ok: allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_changes',
    description:
      'Per-repo change digest: the files that moved, line counts, and each repo\'s recent commit subjects as a style reference. '
      + 'Step 1 of the two-step commit flow — write one commit message per repo from its own diff, then call git_workspace_commit with a messages map.',
    parameters: {
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Collect workspace changes', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const result = await changesAll(root, { maxDepth, concurrency: config.concurrency });
      return {
        text: formatChanges(result),
        repos: result.rows.filter((row) => row.ok && row.hasChanges).map((row) => row.repo),
        ok: allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_commit',
    description:
      'Commit repos in one batch, each with its OWN message. `messages` maps a repo label (as shown by git_workspace_changes) to that repo\'s commit message; '
      + 'a repo with no entry is skipped, never committed with a shared message. Call git_workspace_changes first to see each diff. '
      + 'By default every pending change is staged first (git add --all). Pass `stagedOnly: true` to commit exactly what is already staged, '
      + 'or `paths` to stage and commit only the listed files. A repo left mid-merge/rebase is refused unless you finish that operation first. '
      + 'Pass dryRun to preview which repos would commit.',
    parameters: {
      messages: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {},
        description: 'Map of repo label (or absolute path) to that repo\'s commit message. One distinct message per repo.',
      },
      paths: {
        type: 'object',
        additionalProperties: true,
        properties: {},
        description: 'Optional map of repo label (or absolute path) to the file paths that commit should include. '
          + 'Those files are staged and committed with `git commit --only`, so unrelated staged work is left in the index.',
      },
      stagedOnly: {
        type: 'boolean',
        description: 'Commit only what is already staged (no `git add --all`). Use after git_workspace_stage.',
      },
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      dryRun: { type: 'boolean', description: 'Preview the batch without staging or committing.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Commit workspace repos', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const messages = args.messages && typeof args.messages === 'object' ? args.messages : {};
      const pathsMap = args.paths && typeof args.paths === 'object' && !Array.isArray(args.paths) ? args.paths : {};
      const dryRun = args.dryRun === true;
      const stagedOnly = args.stagedOnly === true;
      const result = await commitAll(root, messages, {
        maxDepth,
        stagedOnly,
        pathsMap,
        dryRun,
        concurrency: config.concurrency,
      });
      return {
        text: formatCommit(result, { dryRun }),
        repos: result.rows.map((row) => row.repo),
        // A key that matched no repo means the model asked for something that
        // did not happen, so it cannot be reported as success.
        ok: allOk(result.rows) && result.unknownKeys.length === 0,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_push',
    description:
      'Push every repo whose branch has an upstream (or set the upstream on first push). Reports per repo; a rejected push does not stop the others. '
      + 'Pass dryRun to preview which repos would push.',
    parameters: {
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      dryRun: { type: 'boolean', description: 'Preview the batch without pushing.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Push workspace repos', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const result = await pushAll(root, {
        maxDepth,
        dryRun: args.dryRun === true,
        concurrency: config.concurrency,
      });
      return {
        text: formatPush(result),
        repos: result.rows.map((row) => row.repo),
        ok: allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_stage',
    description:
      'Stage or unstage specific files in one or more repos — the file-level counterpart of `git add` / `git restore --staged`. '
      + '`files` maps a repo label (as shown by git_workspace_status) to the paths to act on; an empty array means "every file in that repo". '
      + 'An unknown repo key fails the call instead of acting on nothing. Then use git_workspace_commit with `stagedOnly: true` to commit exactly that. '
      + 'Pass dryRun to preview.',
    parameters: {
      files: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {},
        description: 'Map of repo label (or absolute path) to an array of repo-relative file paths.',
      },
      action: {
        type: 'string',
        enum: ['stage', 'unstage'],
        description: "'stage' (git add) or 'unstage' (git restore --staged). Default 'stage'.",
      },
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      dryRun: { type: 'boolean', description: 'Report what would be staged/unstaged without touching the index.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Stage files', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const action = args.action === 'unstage' ? 'unstage' : 'stage';
      const files = args.files && typeof args.files === 'object' && !Array.isArray(args.files) ? args.files : {};
      const dryRun = args.dryRun === true;
      const result = await applyFiles(root, files, { action, maxDepth, dryRun });
      return {
        text: formatFiles(result, { action, dryRun }),
        repos: result.rows.map((row) => row.repo),
        ok: result.unknownKeys.length === 0 && allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_restore',
    description:
      'Throw away or park file changes in one or more repos. '
      + '`action: "discard"` restores tracked files from the index and deletes untracked files — irreversible, so it requires `confirm: true` and refuses otherwise; '
      + 'run it with `dryRun: true` first to see exactly which paths would disappear. '
      + '`action: "stash"` moves the changes into a stash instead (recoverable with `git stash pop` in that repo). '
      + '`files` maps a repo label to paths; an empty array means "every change in that repo".',
    parameters: {
      files: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {},
        description: 'Map of repo label (or absolute path) to an array of repo-relative file paths.',
      },
      action: {
        type: 'string',
        enum: ['discard', 'stash'],
        description: "'discard' deletes the changes (needs confirm: true); 'stash' parks them recoverably.",
      },
      confirm: { type: 'boolean', description: 'Required for action "discard": acknowledges that untracked files are deleted for good.' },
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      dryRun: { type: 'boolean', description: 'Report what would be discarded or stashed without touching the worktree.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Restore files', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const action = args.action === 'stash' ? 'stash' : 'discard';
      const files = args.files && typeof args.files === 'object' && !Array.isArray(args.files) ? args.files : {};
      const dryRun = args.dryRun === true;
      const result = await applyFiles(root, files, { action, maxDepth, dryRun, confirm: args.confirm === true });
      return {
        text: formatFiles(result, { action, dryRun }),
        repos: result.rows.map((row) => row.repo),
        ok: result.unknownKeys.length === 0 && allOk(result.rows),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'git_workspace_conflicts',
    description:
      'Work with an in-progress merge / rebase / cherry-pick / revert and the files it left unmerged. '
      + '`action: "list"` (default) reports every repo with an operation in progress or conflicted files, including the file names. '
      + '`ours` / `theirs` / `stage` resolve the listed `paths` in one `repo`, then stage them (ours/theirs pick that side of the conflict; '
      + 'git swaps their meaning during a rebase). '
      + '`continue` finishes the operation — for a merge it commits the merge, optionally with `message`. '
      + '`abort` throws the operation and every resolution already made away: pass `confirm: true`, and use `dryRun: true` first to see what is lost.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'ours', 'theirs', 'stage', 'continue', 'abort'],
        description: "Default 'list'. Resolve actions need `repo` + `paths`; continue/abort need `repo`.",
      },
      repo: { type: 'string', description: 'Repo label (from git_workspace_status) or absolute path. Required unless action is list.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative conflicted file paths. Required for ours / theirs / stage.',
      },
      message: { type: 'string', description: 'Optional merge commit message for action continue (default: git\'s stored merge message).' },
      confirm: { type: 'boolean', description: 'Required for abort: acknowledges that the operation and its resolutions are discarded.' },
      root: { type: 'string', description: 'Directory to scan. Defaults to the session workspace.' },
      maxDepth: { type: 'integer', description: 'How deep to descend. Default 3.' },
      dryRun: { type: 'boolean', description: 'For abort: list the operation and files that would be thrown away instead of doing it.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Workspace conflicts', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.root, config);
      const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : config.maxDepth;
      const action = ['list', 'ours', 'theirs', 'stage', 'continue', 'abort'].includes(args.action) ? args.action : 'list';

      if (action === 'list') {
        const result = await statusAll(root, { maxDepth, concurrency: config.concurrency });
        return {
          text: formatConflicts(result),
          repos: result.rows.map((row) => row.repo),
          ok: allOk(result.rows),
        };
      }

      const repoPath = await resolveRepoKey(root, args.repo, { maxDepth });
      const label = repoLabel(repoPath, root);

      if (action === 'continue' || action === 'abort') {
        if (action === 'abort' && args.dryRun === true) {
          const status = await repoStatus(repoPath, { root });
          const paths = status.ok ? (status.conflictPaths ?? []) : [];
          return {
            text: `**abort preview** · ${label} · ${status.ok ? status.sequencer ?? 'no operation' : 'status failed'}\n\n`
              + `Would discard the in-progress operation and these resolutions: ${paths.length ? paths.join(', ') : '—'}.\n\n`
              + 'Call again with `confirm: true` to actually abort.',
            repos: [label],
            ok: true,
          };
        }
        if (action === 'abort' && args.confirm !== true) {
          throw new Error('abort discards the in-progress operation and its resolutions — pass confirm: true to do it (dryRun: true shows what would be lost)');
        }
        const result = await sequencerAction(repoPath, action, { message: typeof args.message === 'string' ? args.message : '' });
        const rows = [{ repo: label, path: repoPath, ok: result.ok, action: result.action, commit: result.commit, error: result.error }];
        const verb = action === 'abort' ? 'aborted' : 'continued';
        const text = result.ok
          ? `**${verb}** · ${label} · ${result.state}${result.commit ? ` · ${result.commit}` : ''}`
          : `**${verb} failed** · ${label} · ${result.error}`;
        return { text, repos: [label], ok: result.ok };
      }

      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p !== '') : [];
      if (paths.length === 0) {
        throw new Error('paths is required for ours / theirs / stage — run action "list" to see the unmerged files');
      }
      const rows = [];
      for (const path of paths) {
        const result = await resolveConflict(repoPath, path, action);
        rows.push({ repo: label, path: repoPath, files: [path], action: result.action, ok: result.ok, error: result.error });
      }
      return {
        text: formatFiles({ root, rows, unknownKeys: [] }, { action }),
        repos: [label],
        ok: allOk(rows),
      };
    },
  }));
}
