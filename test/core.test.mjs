/**
 * Core behaviour against a real multi-repo workspace.
 * Everything here runs actual git; no mocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, run } from './fixtures.mjs';
import {
  changesAll,
  commitAll,
  discoverRepos,
  pushAll,
  repoStatus,
  statusAll,
  syncAll,
} from '../lib/git.mjs';
import { formatStatus } from '../lib/format.mjs';

const ws = makeWorkspace();
test.after(() => ws.dispose());

const rel = (p) => p.slice(ws.root.length).replace(/\\/g, '/');

test('discoverRepos finds every project and skips node_modules', async () => {
  const repos = await discoverRepos(ws.root);
  const names = repos.map(rel);
  assert.ok(names.includes('/app'), `missing /app in ${names.join(', ')}`);
  assert.ok(names.includes('/app-dirty'));
  assert.ok(names.includes('/app-nested/deep'));
  assert.ok(!names.some((n) => n.includes('node_modules')), 'node_modules must stay out');
  assert.ok(!names.some((n) => n.includes('remotes')), 'bare remotes are not projects');
});

test('discoverRepos honours maxDepth', async () => {
  const repos = await discoverRepos(ws.root, { maxDepth: 1 });
  assert.ok(!repos.map(rel).includes('/app-nested/deep'), 'depth 2 repo must be out of a depth-1 scan');
});

test('statusAll reports clean, dirty, ahead, and behind per repo', async () => {
  const { rows } = await statusAll(ws.root);
  const by = Object.fromEntries(rows.map((r) => [r.repo, r]));

  assert.equal(by.app.dirty, false);
  assert.equal(by.app.branch, 'main');
  assert.equal(by['app-dirty'].dirty, true);
  assert.equal(by['app-dirty'].modified, 1);
  assert.equal(by['app-dirty'].untracked, 1);
  assert.ok(by['app-behind'].behind >= 1, `expected behind, got ${by['app-behind'].behind}`);
  assert.ok(by['app-ahead'].ahead >= 1, `expected ahead, got ${by['app-ahead'].ahead}`);
});

test('formatStatus renders a table with every repo', async () => {
  const result = await statusAll(ws.root);
  const text = formatStatus(result);
  assert.match(text, /\| repo \| branch \|/);
  for (const row of result.rows) assert.ok(text.includes(row.repo), `${row.repo} missing from table`);
});

test('changesAll digests per-repo diffs for message writing', async () => {
  const { rows } = await changesAll(ws.root);
  const dirty = rows.find((r) => r.repo === 'app-dirty');
  assert.equal(dirty.hasChanges, true);
  const paths = dirty.files.map((f) => f.path);
  assert.ok(paths.some((p) => p.endsWith('README.md')));
  assert.ok(paths.some((p) => p.endsWith('new-file.txt')));
  assert.ok(dirty.recentCommits.length > 0, 'style hints come from existing commits');

  const clean = rows.find((r) => r.repo === 'app');
  assert.equal(clean.hasChanges, false);
});

test('commitAll commits only repos with a supplied message, each with its own', async () => {
  const { rows, skipped, unknownKeys } = await commitAll(ws.root, {
    'app-dirty': 'fix: rewrite readme and add new file',
    'no-such-repo': 'chore: ignored',
  });

  const dirty = rows.find((r) => r.repo === 'app-dirty');
  assert.equal(dirty.action, 'committed');
  assert.equal(dirty.message, 'fix: rewrite readme and add new file');
  assert.ok(dirty.commit, 'commit hash returned');

  assert.ok(skipped.includes('app'), 'clean repo without a message is skipped');
  assert.deepEqual(unknownKeys, ['no-such-repo'], 'unknown keys are reported, not silently dropped');

  const subject = run(['log', '-1', '--pretty=%s'], ws.paths.dirty);
  assert.equal(subject, 'fix: rewrite readme and add new file');
  const cleanSubject = run(['log', '-1', '--pretty=%s'], ws.paths.app);
  assert.notEqual(cleanSubject, 'fix: rewrite readme and add new file');

  // Restore the dirty state later tests depend on.
  const fs = await import('node:fs');
  fs.writeFileSync(`${ws.paths.dirty}/follow-up.txt`, 'dirty again\n');
});

test('commitAll dryRun stages and commits nothing', async () => {
  const fs = await import('node:fs');
  fs.writeFileSync(`${ws.paths.app}/scratch.txt`, 'x\n');
  run(['add', '--all'], ws.paths.app);
  run(['commit', '-m', 'chore: scratch'], ws.paths.app);
  fs.writeFileSync(`${ws.paths.app}/dry.txt`, 'y\n');

  const before = run(['rev-parse', 'HEAD'], ws.paths.app);
  const { rows } = await commitAll(ws.root, { app: 'test: should not land' }, { dryRun: true });
  assert.equal(rows.find((r) => r.repo === 'app').action, 'would-commit');
  const after = run(['rev-parse', 'HEAD'], ws.paths.app);
  assert.equal(before, after, 'dry run must not move HEAD');
  assert.equal(run(['log', '-1', '--pretty=%s'], ws.paths.app), 'chore: scratch');

  fs.rmSync(`${ws.paths.app}/dry.txt`, { force: true });
});

test('syncAll dryRun reports without fetching or integrating', async () => {
  const { rows } = await syncAll(ws.root, { dryRun: true });
  const behind = rows.find((r) => r.repo === 'app-behind');
  assert.equal(behind.action, 'would-sync');
  assert.ok(behind.behind >= 1);
  const stillBehind = await repoStatus(ws.paths.behind, { root: ws.root });
  assert.ok(stillBehind.behind >= 1, 'dry run must leave the repo behind');
});

test('syncAll refuses a dirty repo and fast-forwards a clean one', async () => {
  const result = await syncAll(ws.root);
  const by = Object.fromEntries(result.rows.map((r) => [r.repo, r]));

  assert.equal(by['app-behind'].ok, true);
  assert.equal(by['app-behind'].action, 'fast-forwarded');
  assert.equal(by['app-behind'].behind, 0);

  assert.equal(by['app-dirty'].ok, false);
  assert.equal(by['app-dirty'].action, 'skipped');
  assert.match(by['app-dirty'].error, /dirty/i);

  assert.equal(by.app.action, 'up-to-date');
});

test('pushAll pushes an unpushed commit', async () => {
  const { rows } = await pushAll(ws.root, { dryRun: true });
  const aheadDry = rows.find((r) => r.repo === 'app-ahead');
  assert.equal(aheadDry.action, 'would-push');
  assert.ok(aheadDry.ahead >= 1);

  const { rows: pushed } = await pushAll(ws.root);
  const aheadRow = pushed.find((r) => r.repo === 'app-ahead');
  assert.equal(aheadRow.action, 'pushed', `push failed: ${aheadRow.error ?? aheadRow.stdout ?? ''}`);

  const originSubject = run(['log', '-1', '--pretty=%s', 'main'], ws.bares['app-ahead']);
  assert.equal(originSubject, 'feat: local only');
  const after = await repoStatus(ws.paths.ahead, { root: ws.root });
  assert.equal(after.ahead, 0, 'ahead clears after a push');
});
