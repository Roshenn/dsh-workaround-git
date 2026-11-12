/**
 * One-click sync: the five batch actions as ONE per-repo pipeline.
 *
 * Per repository, in order:
 *   1. fetch the remote (never integrates anything by itself)
 *   2. if the tree is dirty, draft a commit message with the model and commit it
 *   3. integrate the remote with `pull --rebase` (the user's explicit choice)
 *   4. push the branch, but only when it is actually ahead
 *
 * Why a module of its own: the pipeline needs both `git.mjs` primitives and the
 * model call in `suggest.mjs`, and `suggest.mjs` already imports `git.mjs`, so
 * `git.mjs` cannot host the orchestration without a cycle.
 *
 * Product constraints this file must keep (see AGENTS.md §5):
 *   - no `reset --hard`, no `push --force`, no history rewrite beyond the rebase
 *     the user asked for;
 *   - a repo left mid-merge / mid-rebase is never silently concluded: it is
 *     skipped and named, so the panel's conflict lane stays the only way out;
 *   - a failed step stops that repo, never the whole batch; every repo is a row.
 */
import {
  commitRepo,
  fetchRepo,
  mapLimit,
  pushRepo,
  repoLabel,
  repoRemote,
  repoSequencer,
  repoStatus,
  stagePaths,
  syncRepo,
} from './git.mjs';
import { suggestMessage } from './suggest.mjs';

/** The integration mode one-click sync uses. Chosen by the user: linear history. */
export const AUTOSYNC_MERGE_MODE = 'rebase';

/** Model calls are the slow part; two in flight matches the existing batch draft. */
const DEFAULT_CONCURRENCY = 2;

/**
 * Run the pipeline for one repository.
 *
 * `suggest` is injected (the caller passes `suggestMessage` bound to the context,
 * tests pass a stub). Without it a dirty repo is skipped rather than committed
 * with an empty or invented message.
 *
 * @returns {Promise<object>} always resolves; a failure is a result row.
 */
export async function autosyncRepo(repoPath, { root, label, suggest } = {}) {
  /** Which step ended how — the row says where a repo stopped. */
  const steps = { fetch: 'skipped', commit: 'skipped', merge: 'skipped', push: 'skipped' };
  const out = (extra) => ({ repoPath, label: label ?? repoLabel(repoPath, root), ...extra, steps });

  const status = await repoStatus(repoPath, { root });
  if (!status.ok) return out({ ok: false, skipped: false, action: 'status-failed', error: status.error });
  // Before anything else: an unfinished merge/rebase would make both the commit
  // and the pull wrong. Leave it alone and say so.
  if (status.sequencer !== null) {
    return out({
      ok: true, skipped: true, action: 'sequencer-active', sequencer: status.sequencer,
      error: `${status.sequencer} in progress: finish or abort it before syncing`,
    });
  }
  if (status.conflicted > 0) {
    return out({
      ok: true, skipped: true, action: 'conflicts',
      error: `${status.conflicted} conflicted file(s) must be resolved before syncing`,
    });
  }
  const remote = await repoRemote(repoPath);
  if (!remote.url) {
    return out({ ok: true, skipped: true, action: 'no-remote', error: 'repository has no remote' });
  }

  const fetched = await fetchRepo(repoPath);
  if (!fetched.ok) {
    steps.fetch = 'failed';
    return out({ ok: false, skipped: false, action: 'fetch-failed', error: fetched.error });
  }
  steps.fetch = 'fetched';

  let message = null;
  let commit = null;
  const pending = status.staged + status.modified + status.untracked;
  if (pending > 0) {
    if (typeof suggest !== 'function') {
      steps.commit = 'no-message';
      return out({ ok: true, skipped: true, action: 'no-message', error: 'no commit-message source is available' });
    }
    const draft = await suggest(repoPath);
    if (!draft.ok) {
      // Skip instead of falling back to a placeholder: an empty "sync" commit
      // would bury the real change under a message nobody wrote.
      steps.commit = 'no-message';
      return out({
        ok: true, skipped: true, action: 'no-message',
        code: draft.error?.code ?? null, error: draft.error?.message ?? 'no commit message',
      });
    }
    const staged = await stagePaths(repoPath, []);
    if (!staged.ok) {
      steps.commit = 'stage-failed';
      return out({ ok: false, skipped: false, action: 'stage-failed', error: staged.error });
    }
    const committed = await commitRepo(repoPath, draft.message, { root, addAll: false });
    if (committed.ok === false) {
      steps.commit = committed.action ?? 'commit-failed';
      return out({ ok: false, skipped: false, action: steps.commit, error: committed.error });
    }
    steps.commit = committed.action ?? 'committed';
    message = committed.message ?? draft.message;
    commit = committed.commit ?? null;
  } else {
    steps.commit = 'nothing-to-commit';
  }

  const merged = await syncRepo(repoPath, { root, mode: AUTOSYNC_MERGE_MODE });
  if (merged.ok === false) {
    // A conflicted rebase leaves the repo on `rebase-merge` / `rebase-apply`.
    // Report it as such (the panel shows the lane) and never push.
    const sequencer = await repoSequencer(repoPath);
    steps.merge = sequencer === 'rebase' ? 'rebase-conflict' : (merged.action ?? 'merge-failed');
    return out({ ok: false, skipped: false, action: steps.merge, error: merged.error, message, commit });
  }
  steps.merge = merged.action ?? 'merged';

  const after = await repoStatus(repoPath, { root });
  if (!after.ok) {
    steps.push = 'status-failed';
    return out({ ok: false, skipped: false, action: 'status-failed', error: after.error, message, commit });
  }
  if (!after.upstream) {
    steps.push = 'no-upstream';
    return out({
      ok: true, skipped: true, action: 'no-upstream', branch: after.branch,
      error: 'branch has no upstream; nothing was pushed', message, commit,
    });
  }
  if ((after.ahead ?? 0) === 0) {
    steps.push = 'up-to-date';
    return out({ ok: true, skipped: false, action: 'synced', branch: after.branch, message, commit });
  }
  // `setUpstream: false`: one-click sync must not publish a new remote branch.
  const pushed = await pushRepo(repoPath, { root, setUpstream: false });
  if (!pushed.ok) {
    steps.push = 'failed';
    return out({ ok: false, skipped: false, action: 'push-failed', error: pushed.error, message, commit });
  }
  steps.push = 'pushed';
  return out({ ok: true, skipped: false, action: 'synced', branch: after.branch, message, commit });
}

/** Run the pipeline for many repository refs, bounded, always one row each. */
export async function autosyncRefs(ctx, refs, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const rows = await mapLimit(refs, concurrency, async (ref) => {
    const base = {
      workspace: ref.workspacePath,
      repo: ref.repoPath,
      repoPath: ref.repoPath,
      label: ref.label,
    };
    const suggest = async (repoPath) => suggestMessage(ctx, repoPath, { root: ref.workspacePath });
    const result = await autosyncRepo(ref.repoPath, {
      root: ref.workspacePath,
      label: ref.label,
      suggest,
    });
    return { ...base, ...result };
  });
  return {
    // `results` matches the shape /api/batch returns, so the client reads the
    // same field for every batch action.
    results: rows,
    okCount: rows.filter((row) => row.ok && !row.skipped).length,
    skippedCount: rows.filter((row) => row.skipped).length,
    failedCount: rows.filter((row) => !row.ok).length,
  };
}
