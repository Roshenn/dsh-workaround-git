/**
 * Conflict lane, sequencer lifecycle and file-scoped commits.
 *
 * These pin the closed loop added in 0.6.0: a conflicted repo is no longer a
 * dead end. It can name its unmerged files, resolve one side, be concluded or
 * aborted deliberately, and commit only the files the caller chose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFiles,
  commitRepo,
  repoSequencer,
  repoStatus,
  resolveConflict,
  sequencerAction,
  stagePaths,
} from '../lib/git.mjs';
import { run } from './fixtures.mjs';

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function makeRepo(files = { 'a.txt': 'a\n', 'b.txt': 'b\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'dshwg-cf-'));
  cleanups.push(dir);
  run(['init', '--initial-branch=main'], dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  run(['add', '.'], dir);
  run(['commit', '-m', 'chore: base'], dir);
  return dir;
}

/** A repo stopped in the middle of a conflicting merge of `feature` into `main`. */
function makeConflictedRepo() {
  const dir = makeRepo({ 'file.txt': 'base\n' });
  run(['switch', '-c', 'feature'], dir);
  writeFileSync(join(dir, 'file.txt'), 'feature\n');
  run(['commit', '-am', 'feat: feature'], dir);
  run(['switch', 'main'], dir);
  writeFileSync(join(dir, 'file.txt'), 'main\n');
  run(['commit', '-am', 'feat: main'], dir);
  try {
    execFileSync('git', ['-C', dir, 'merge', 'feature'], { stdio: 'pipe' });
  } catch {
    // the conflict is the point
  }
  return dir;
}

function porcelain(dir) {
  // `run()` trims its output, which would eat the leading space of " M file"
  // and turn an unstaged change into what looks like a staged one.
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

/** File content with Windows checkouts normalized, so the assertions are about git, not CRLF. */
function content(dir, name) {
  return readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
}

test('a stopped merge is detected and its conflicted files are named', async () => {
  const dir = makeConflictedRepo();
  const status = await repoStatus(dir);
  assert.equal(status.ok, true);
  assert.equal(status.sequencer, 'merge');
  assert.equal(status.conflicted, 1);
  assert.deepEqual(status.conflictPaths, ['file.txt']);
  assert.equal(await repoSequencer(dir), 'merge');
});

test('resolveConflict picks a side, stages it and refuses outside the repo', async () => {
  const dir = makeConflictedRepo();
  const ours = await resolveConflict(dir, 'file.txt', 'ours');
  assert.equal(ours.ok, true);
  assert.equal(ours.action, 'resolved');
  assert.equal(content(dir, 'file.txt'), 'main\n');
  // Taking `ours` restores content that already matches HEAD, so the tree is
  // clean while the merge is still in progress — the case that used to make the
  // merge commit impossible.
  assert.deepEqual(porcelain(dir), []);
  assert.equal((await repoStatus(dir)).conflicted, 0);
  assert.equal((await repoStatus(dir)).sequencer, 'merge');

  const outside = await resolveConflict(dir, '../escape.txt', 'ours');
  assert.equal(outside.ok, false);
  assert.equal(outside.action, 'refused');
});

test('resolveConflict can take the other side, and mark a hand-edited file resolved', async () => {
  const theirs = makeConflictedRepo();
  assert.equal((await resolveConflict(theirs, 'file.txt', 'theirs')).ok, true);
  assert.equal(content(theirs, 'file.txt'), 'feature\n');

  const hand = makeConflictedRepo();
  writeFileSync(join(hand, 'file.txt'), 'hand resolved\n');
  const marked = await resolveConflict(hand, 'file.txt', 'stage');
  assert.equal(marked.ok, true);
  assert.equal(content(hand, 'file.txt'), 'hand resolved\n');
  assert.deepEqual(porcelain(hand), ['M  file.txt']);
});

test('resolveConflict refuses a file that is not unmerged', async () => {
  const dir = makeRepo();
  const result = await resolveConflict(dir, 'a.txt', 'ours');
  assert.equal(result.ok, false);
  assert.equal(result.action, 'not-conflicted');
});

test('a commit cannot silently conclude a merge, and allowSequencer can', async () => {
  const dir = makeConflictedRepo();
  await resolveConflict(dir, 'file.txt', 'ours');

  const refused = await commitRepo(dir, 'merge: feature', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.action, 'sequencer-active');

  const committed = await commitRepo(dir, 'merge: feature', { allowSequencer: true });
  assert.equal(committed.ok, true);
  assert.equal(committed.action, 'committed');
  assert.equal(await repoSequencer(dir), null);
  // a real merge commit, not a normal commit on top
  const parents = run(['log', '-1', '--pretty=%p'], dir).split(' ').filter(Boolean);
  assert.equal(parents.length, 2);
});

test('sequencer continue finishes a merge and abort throws it away', async () => {
  const continued = makeConflictedRepo();
  await resolveConflict(continued, 'file.txt', 'theirs');
  const result = await sequencerAction(continued, 'continue');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'continued');
  assert.equal(result.state, 'merge');
  assert.equal(await repoSequencer(continued), null);
  assert.equal(run(['log', '-1', '--pretty=%s'], continued), 'Merge branch \'feature\'');

  const aborted = makeConflictedRepo();
  await resolveConflict(aborted, 'file.txt', 'ours');
  const abortResult = await sequencerAction(aborted, 'abort');
  assert.equal(abortResult.ok, true);
  assert.equal(await repoSequencer(aborted), null);
  assert.equal(content(aborted, 'file.txt'), 'main\n');
  assert.deepEqual(porcelain(aborted), []);
});

test('sequencerAction refuses to continue while conflicts remain and when idle', async () => {
  const dir = makeConflictedRepo();
  const blocked = await sequencerAction(dir, 'continue');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.action, 'conflicts-remaining');
  assert.deepEqual(blocked.conflicts, ['file.txt']);

  const idle = makeRepo();
  const none = await sequencerAction(idle, 'abort');
  assert.equal(none.ok, false);
  assert.equal(none.action, 'no-sequencer');
});

test('stagedOnly commits the index only, leaving the worktree alone', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'a changed\n');
  writeFileSync(join(dir, 'b.txt'), 'b changed\n');
  assert.equal((await stagePaths(dir, ['a.txt'])).ok, true);

  const result = await commitRepo(dir, 'feat: a', { stagedOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'committed');
  assert.equal(result.mode, 'staged');
  assert.deepEqual(porcelain(dir), [' M b.txt']);
});

test('paths commits only the listed files and keeps the rest of the index', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'a changed\n');
  writeFileSync(join(dir, 'b.txt'), 'b changed\n');
  // b.txt is staged work that must survive a scoped commit of a.txt
  assert.equal((await stagePaths(dir, ['b.txt'])).ok, true);

  const result = await commitRepo(dir, 'feat: a', { paths: ['a.txt'] });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'paths');
  assert.deepEqual(porcelain(dir), ['M  b.txt']);
});

test('paths outside the repository are refused before git runs', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'a changed\n');
  const result = await commitRepo(dir, 'feat: a', { paths: ['../escape.txt'] });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'refused');
  assert.match(result.error, /outside repository/);
});

test('applyFiles stages by label, refuses discard without confirmation, and reports unknown keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshwg-files-'));
  cleanups.push(root);
  const dir = join(root, 'repo-one');
  mkdirSync(dir);
  run(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  run(['add', '.'], dir);
  run(['commit', '-m', 'chore: base'], dir);
  writeFileSync(join(dir, 'a.txt'), 'a changed\n');

  const staged = await applyFiles(root, { 'repo-one': ['a.txt'] }, { action: 'stage', maxDepth: 2 });
  assert.equal(staged.rows.length, 1);
  assert.equal(staged.rows[0].ok, true);
  assert.deepEqual(porcelain(dir), ['M  a.txt']);

  const unstaged = await applyFiles(root, { 'repo-one': ['a.txt'] }, { action: 'unstage', maxDepth: 2 });
  assert.equal(unstaged.rows[0].ok, true);
  assert.deepEqual(porcelain(dir), [' M a.txt']);

  const refused = await applyFiles(root, { 'repo-one': ['a.txt'] }, { action: 'discard', maxDepth: 2 });
  assert.equal(refused.rows[0].ok, false);
  assert.match(refused.rows[0].error, /confirm: true/);
  assert.deepEqual(porcelain(dir), [' M a.txt']);

  const discarded = await applyFiles(root, { 'repo-one': ['a.txt'] }, { action: 'discard', maxDepth: 2, confirm: true });
  assert.equal(discarded.rows[0].ok, true);
  assert.deepEqual(porcelain(dir), []);

  const unknown = await applyFiles(root, { nope: ['a.txt'] }, { action: 'stage', maxDepth: 2 });
  assert.deepEqual(unknown.unknownKeys, ['nope']);
  assert.equal(unknown.rows.length, 0);
});
