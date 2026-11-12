/**
 * One-click sync pipeline: fetch -> draft + commit -> rebase -> push, per repo.
 *
 * Every case runs real git against a throwaway repo with its own bare origin,
 * and passes a stub `suggest` so no model is involved: what is pinned here is
 * the pipeline's step order, its stop conditions and the rows it reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autosyncRefs, autosyncRepo } from '../lib/autosync.mjs';
import { repoSequencer, repoStatus } from '../lib/git.mjs';
import { run } from './fixtures.mjs';

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/**
 * A repo with its own bare origin, pushed and clean.
 * Separate origins per repo keep concurrent pushes from racing on one ref.
 */
function makeRemoteRepo(name, { remote = true } = {}) {
  const root = tempRoot(`dshwg-auto-${name}-`);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  run(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  run(['add', '.'], dir);
  run(['commit', '-m', 'chore: base'], dir);
  if (!remote) return { dir, bare: null };
  const bare = join(root, 'origin.git');
  run(['init', '--bare', '--initial-branch=main', bare]);
  run(['remote', 'add', 'origin', bare], dir);
  run(['push', '--quiet', '-u', 'origin', 'main'], dir);
  return { dir, bare };
}

/** Move the bare origin forward by one commit from a scratch clone. */
function advanceRemote(bare, file, content, message = 'feat: remote advance') {
  const scratch = tempRoot('dshwg-auto-scratch-');
  run(['clone', '--quiet', bare, scratch], undefined);
  writeFileSync(join(scratch, file), content);
  run(['add', '.'], scratch);
  run(['commit', '-m', message], scratch);
  run(['push', '--quiet'], scratch);
}

const okModel = async () => ({ ok: true, message: 'test: one-click sync' });
const brokenModel = async () => ({ ok: false, error: { code: 'llm-unavailable', message: 'no llm service' } });

function subject(dir) {
  return run(['log', '-1', '--pretty=%s'], dir);
}

test('a dirty repo is committed and pushed in one call', async () => {
  const { dir, bare } = makeRemoteRepo('dirty');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  writeFileSync(join(dir, 'README.md'), 'base\nlocal change\n');
  writeFileSync(join(dir, 'new-file.txt'), 'untracked\n');

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.ok, true);
  assert.equal(row.skipped, false);
  assert.equal(row.action, 'synced');
  assert.equal(row.steps.fetch, 'fetched');
  assert.equal(row.steps.commit, 'committed');
  assert.equal(row.steps.push, 'pushed');
  assert.equal(subject(dir), 'test: one-click sync');
  const status = await repoStatus(dir);
  assert.equal(status.dirty, false, 'the commit covers staged, modified and untracked');
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
  // The pushed branch carries both the local commit and the remote one.
  assert.equal(run(['log', '-1', '--pretty=%s', 'origin/main'], dir), 'test: one-click sync');
});

test('a repo that is only behind fast-forwards without a commit', async () => {
  const { dir, bare } = makeRemoteRepo('behind');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  const before = run(['rev-parse', 'HEAD'], dir);

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.action, 'synced');
  assert.equal(row.steps.commit, 'nothing-to-commit');
  assert.equal(row.steps.merge, 'rebased');
  assert.notEqual(run(['rev-parse', 'HEAD'], dir), before);
  assert.equal(run(['log', '-1', '--pretty=%s'], dir), 'feat: remote advance');
  assert.equal(run(['log', '--merges', '--pretty=%h'], dir), '', 'no merge commit is created');
});

test('a diverged repo is rebased, not merged', async () => {
  const { dir, bare } = makeRemoteRepo('diverged');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  writeFileSync(join(dir, 'LOCAL.md'), 'local\n');
  run(['add', '.'], dir);
  run(['commit', '-m', 'feat: local work'], dir);

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.action, 'synced');
  assert.equal(row.steps.merge, 'rebased');
  assert.equal(row.steps.push, 'pushed');
  assert.equal(run(['log', '--merges', '--pretty=%h'], dir), '', 'linear history: no merge commit');
  assert.equal(run(['log', '-1', '--pretty=%s', 'origin/main'], dir), 'feat: local work');
  const status = await repoStatus(dir);
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
});

test('a repo with no commit message is skipped, not committed', async () => {
  const { dir, bare } = makeRemoteRepo('nomessage');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  const head = run(['rev-parse', 'HEAD'], dir);
  const remoteHead = run(['rev-parse', 'main'], bare);

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: brokenModel });

  assert.equal(row.ok, true);
  assert.equal(row.skipped, true);
  assert.equal(row.action, 'no-message');
  assert.equal(row.error, 'no llm service');
  assert.equal(run(['rev-parse', 'HEAD'], dir), head, 'HEAD must not move');
  assert.equal(run(['rev-parse', 'main'], bare), remoteHead, 'nothing may be pushed');
  assert.equal((await repoStatus(dir)).dirty, true, 'the working tree is left alone');
});

test('a repo without a message source at all is skipped instead of guessed at', async () => {
  const { dir } = makeRemoteRepo('nosource');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  const head = run(['rev-parse', 'HEAD'], dir);

  const row = await autosyncRepo(dir, { root: join(dir, '..') });

  assert.equal(row.action, 'no-message');
  assert.equal(row.skipped, true);
  assert.equal(run(['rev-parse', 'HEAD'], dir), head);
});

test('a repo with no remote is skipped, not reported as a failure', async () => {
  const { dir } = makeRemoteRepo('noremote', { remote: false });

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.ok, true);
  assert.equal(row.skipped, true);
  assert.equal(row.action, 'no-remote');
  assert.equal(row.steps.fetch, 'skipped');
});

test('a repo left mid-merge is refused instead of concluded', async () => {
  const { dir, bare } = makeRemoteRepo('stuck');
  advanceRemote(bare, 'README.md', 'remote side\n');
  run(['fetch', '--quiet'], dir);
  writeFileSync(join(dir, 'README.md'), 'local side\n');
  run(['commit', '-am', 'feat: local side'], dir);
  try {
    run(['merge', 'origin/main'], dir);
  } catch {
    // the conflict is the point
  }
  const head = run(['rev-parse', 'HEAD'], dir);

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.skipped, true);
  assert.equal(row.action, 'sequencer-active');
  assert.equal(row.sequencer, 'merge');
  assert.equal(run(['rev-parse', 'HEAD'], dir), head);
  assert.equal(await repoSequencer(dir), 'merge');
});

test('a conflicting rebase stops the repo, leaves it mid-rebase and never pushes', async () => {
  const { dir, bare } = makeRemoteRepo('conflict');
  advanceRemote(bare, 'README.md', 'remote side\n');
  writeFileSync(join(dir, 'README.md'), 'local side\n');
  run(['commit', '-am', 'feat: local side'], dir);
  const remoteHead = run(['rev-parse', 'main'], bare);
  const localHead = run(['rev-parse', 'HEAD'], dir);

  const row = await autosyncRepo(dir, { root: join(dir, '..'), suggest: okModel });

  assert.equal(row.ok, false);
  assert.equal(row.action, 'rebase-conflict');
  assert.equal(row.steps.push, 'skipped');
  assert.equal(run(['rev-parse', 'main'], bare), remoteHead, 'the remote must not move');
  // A stopped rebase leaves HEAD on the `onto` commit; the local commit is
  // preserved in the rebase state and recoverable through ORIG_HEAD.
  assert.equal(run(['rev-parse', 'ORIG_HEAD'], dir), localHead, 'the local commit is preserved');
  assert.equal(await repoSequencer(dir), 'rebase', 'the repo stays mid-rebase for the conflict lane');
});

test('autosyncRefs counts synced, skipped and failed repos per row', async () => {
  const root = tempRoot('dshwg-auto-batch-');
  const ok = join(root, 'ok');
  const remoteLess = join(root, 'local-only');
  mkdirSync(ok, { recursive: true });
  run(['init', '--initial-branch=main'], ok);
  writeFileSync(join(ok, 'a.txt'), 'a\n');
  run(['add', '.'], ok);
  run(['commit', '-m', 'chore: base'], ok);
  mkdirSync(remoteLess, { recursive: true });
  run(['init', '--initial-branch=main'], remoteLess);
  writeFileSync(join(remoteLess, 'a.txt'), 'a\n');
  run(['add', '.'], remoteLess);
  run(['commit', '-m', 'chore: base'], remoteLess);

  const fakeCtx = {};
  const result = await autosyncRefs(fakeCtx, [
    { workspacePath: root, repoPath: ok, label: 'ok' },
    { workspacePath: root, repoPath: remoteLess, label: 'local-only' },
  ], { concurrency: 2 });

  assert.equal(result.results.length, 2);
  assert.equal(result.okCount, 0, 'a repo with no remote is skipped, not synced');
  assert.equal(result.skippedCount, 2);
  assert.equal(result.failedCount, 0);
  const row = result.results.find((r) => r.label === 'ok');
  assert.equal(row.action, 'no-remote');
  assert.equal(row.workspace, root);
  assert.equal(row.repo, ok, 'the row names the repo path, like /api/batch');
});
