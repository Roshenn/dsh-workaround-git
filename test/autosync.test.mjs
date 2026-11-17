/**
 * One-click sync job: parallel waves, per-repo rows and per-stage progress.
 *
 * Every case runs real git against a throwaway repo with its own bare origin.
 * The model is a fake `llm` service on a stub ctx, so the pipeline is exercised
 * end to end without a provider and without timing-dependent assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteRemoteFetch, runAutosync, startAutosync, STAGES } from '../lib/autosync.mjs';
import { repoSequencer, repoStatus } from '../lib/git.mjs';
import { run } from './fixtures.mjs';

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Each case must start with no recorded remote fetch, so wave 1 really runs. */
test.beforeEach(() => { noteRemoteFetch(0); });

function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/**
 * A ctx whose `llm` streams a fixed message. `answer` may be a function of the
 * call index so one repo can be slow while another is fast.
 */
function fakeCtx(answer = 'test: one-click sync') {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* stream() {
            const text = typeof answer === 'function' ? await answer() : answer;
            yield { type: 'text-delta', text };
            yield { type: 'finish', reason: 'stop' };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
}

/** A ctx with no llm service at all: the draft step must skip, not invent text. */
const noModelCtx = { get: () => undefined };

/** A ctx whose model call throws. */
function brokenCtx() {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* stream() {
            throw new Error('model down');
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
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
  if (!remote) return { dir, bare: null, root };
  const bare = join(root, 'origin.git');
  run(['init', '--bare', '--initial-branch=main', bare]);
  run(['remote', 'add', 'origin', bare], dir);
  run(['push', '--quiet', '-u', 'origin', 'main'], dir);
  return { dir, bare, root };
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

function ref(root, dir) {
  return { workspacePath: root, repoPath: dir, label: dir.split('/').pop() };
}

const subject = (dir) => run(['log', '-1', '--pretty=%s'], dir);

test('a dirty repo is fetched, committed and pushed in one job', async () => {
  const { dir, bare, root } = makeRemoteRepo('dirty');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  writeFileSync(join(dir, 'README.md'), 'base\nlocal change\n');
  writeFileSync(join(dir, 'new-file.txt'), 'untracked\n');

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);

  assert.equal(job.status, 'done');
  assert.equal(job.okCount, 1);
  const row = job.rows[0];
  assert.equal(row.state, 'done');
  assert.equal(row.action, 'synced');
  for (const stage of STAGES) assert.equal(row.steps[stage], 'done', `${stage} must be done`);
  assert.ok(row.ms.draft > 0, 'the draft stage is timed');
  assert.equal(subject(dir), 'test: one-click sync');
  const status = await repoStatus(dir);
  assert.equal(status.dirty, false, 'the commit covers staged, modified and untracked');
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
  assert.equal(run(['log', '-1', '--pretty=%s', 'origin/main'], dir), 'test: one-click sync');
});

test('a repo that is only behind fast-forwards without a commit', async () => {
  const { dir, bare, root } = makeRemoteRepo('behind');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  const before = run(['rev-parse', 'HEAD'], dir);

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'done');
  assert.equal(row.steps.draft, 'skipped');
  assert.equal(row.steps.commit, 'skipped');
  assert.equal(row.steps.merge, 'done');
  assert.notEqual(run(['rev-parse', 'HEAD'], dir), before);
  assert.equal(subject(dir), 'feat: remote advance');
  assert.equal(run(['log', '--merges', '--pretty=%h'], dir), '', 'no merge commit is created');
});

test('a diverged repo is rebased, not merged', async () => {
  const { dir, bare, root } = makeRemoteRepo('diverged');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  writeFileSync(join(dir, 'LOCAL.md'), 'local\n');
  run(['add', '.'], dir);
  run(['commit', '-m', 'feat: local work'], dir);

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'done');
  assert.equal(row.steps.merge, 'done');
  assert.equal(row.steps.push, 'done');
  assert.equal(run(['log', '--merges', '--pretty=%h'], dir), '', 'linear history: no merge commit');
  assert.equal(run(['log', '-1', '--pretty=%s', 'origin/main'], dir), 'feat: local work');
  const status = await repoStatus(dir);
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
});

test('a repo whose draft fails is skipped, not committed', async () => {
  const { dir, bare, root } = makeRemoteRepo('nomessage');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  const head = run(['rev-parse', 'HEAD'], dir);
  const remoteHead = run(['rev-parse', 'main'], bare);

  const job = await runAutosync(brokenCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(job.status, 'done');
  assert.equal(row.state, 'skipped');
  assert.equal(row.action, 'no-message');
  assert.equal(row.steps.draft, 'failed');
  assert.equal(row.error, 'model down');
  assert.equal(run(['rev-parse', 'HEAD'], dir), head, 'HEAD must not move');
  assert.equal(run(['rev-parse', 'main'], bare), remoteHead, 'nothing may be pushed');
  assert.equal((await repoStatus(dir)).dirty, true, 'the working tree is left alone');
});

test('a repo with no model at all is skipped instead of guessed at', async () => {
  const { dir, root } = makeRemoteRepo('nomodel');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  const head = run(['rev-parse', 'HEAD'], dir);

  const job = await runAutosync(noModelCtx, [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'skipped');
  assert.equal(row.action, 'no-message');
  assert.equal(run(['rev-parse', 'HEAD'], dir), head);
});

test('a repo with no remote is skipped, not reported as a failure', async () => {
  const { dir, root } = makeRemoteRepo('noremote', { remote: false });

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'skipped');
  assert.equal(row.action, 'no-remote');
  assert.equal(job.skippedCount, 1);
  assert.equal(job.failedCount, 0);
  assert.equal(row.steps.fetch, 'skipped', 'an unstarted stage stays grey, not green');
});

test('a repo left mid-merge is refused instead of concluded', async () => {
  const { dir, bare, root } = makeRemoteRepo('stuck');
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

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'skipped');
  assert.equal(row.action, 'sequencer-active');
  assert.equal(run(['rev-parse', 'HEAD'], dir), head);
  assert.equal(await repoSequencer(dir), 'merge');
});

test('a conflicting rebase stops the repo and never pushes', async () => {
  const { dir, bare, root } = makeRemoteRepo('conflict');
  advanceRemote(bare, 'README.md', 'remote side\n');
  writeFileSync(join(dir, 'README.md'), 'local side\n');
  run(['commit', '-am', 'feat: local side'], dir);
  const remoteHead = run(['rev-parse', 'main'], bare);
  const localHead = run(['rev-parse', 'HEAD'], dir);

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(row.state, 'failed');
  assert.equal(row.action, 'rebase-conflict');
  assert.equal(row.steps.merge, 'failed');
  assert.equal(row.steps.push, 'skipped');
  assert.equal(run(['rev-parse', 'main'], bare), remoteHead, 'the remote must not move');
  // A stopped rebase leaves HEAD on the `onto` commit; the local commit is
  // preserved in the rebase state and recoverable through ORIG_HEAD.
  assert.equal(run(['rev-parse', 'ORIG_HEAD'], dir), localHead, 'the local commit is preserved');
  assert.equal(await repoSequencer(dir), 'rebase', 'the repo stays mid-rebase for the conflict lane');
});

test('a job reports one row per repo and counts settled work', async () => {
  const first = makeRemoteRepo('batch-a');
  const second = makeRemoteRepo('batch-b', { remote: false });
  run(['push', '--quiet', '-u', 'origin', 'main'], first.dir);

  const job = await runAutosync(fakeCtx(), [ref(first.root, first.dir), ref(second.root, second.dir)]);

  assert.equal(job.total, 2);
  assert.equal(job.doneCount, 2);
  assert.equal(job.rows.length, 2);
  assert.equal(job.okCount, 1, 'the repo with a remote syncs');
  assert.equal(job.skippedCount, 1, 'the local-only repo is skipped');
  assert.equal(job.failedCount, 0);
  assert.ok(job.elapsedMs >= 0);
  assert.equal(job.rows[0].workspace, first.root);
  assert.equal(job.rows[0].repo, first.dir);
});

test('a running job reports per-stage progress and can be polled', async () => {
  const { dir, root } = makeRemoteRepo('progress');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const ctx = fakeCtx(async () => {
    await gate;
    return 'test: gated';
  });

  const started = startAutosync(ctx, [ref(root, dir)]);
  assert.equal(started.status, 'running');
  assert.equal(started.doneCount, 0);
  assert.equal(started.rows.length, 1);
  // The row exists before any stage finishes, so the card can paint its dots.
  assert.ok(started.rows[0].steps !== undefined);
  assert.ok([...STAGES, null].includes(started.rows[0].stage));

  // A second start joins the running job instead of competing on the same repos.
  const joined = startAutosync(ctx, [ref(root, dir)]);
  assert.equal(joined.id, started.id);

  release();
  const job = await runAutosync(ctx, [ref(root, dir)]);
  assert.equal(job.id, started.id, 'runAutosync joins the same job');
  assert.equal(job.status, 'done');
  assert.equal(job.rows[0].action, 'synced');
});

test('a fresh remote check is reused instead of fetching every repo again', async () => {
  const { dir, bare, root } = makeRemoteRepo('reuse');
  advanceRemote(bare, 'REMOTE.md', 'remote\n');
  writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  // The panel's background check fetched a moment ago.
  noteRemoteFetch();
  run(['fetch', '--quiet'], dir);

  const job = await runAutosync(fakeCtx(), [ref(root, dir)]);
  const row = job.rows[0];

  assert.equal(job.reusedFetch, true);
  assert.equal(row.reused, true);
  assert.equal(row.ms.fetch, 0, 'no fetch round trip was paid');
  assert.equal(row.steps.fetch, 'done');
  assert.equal(row.action, 'synced', 'the sync still fast-forwards on the cached refs');
  assert.equal(run(['log', '-1', '--pretty=%s', 'origin/main'], dir), 'test: one-click sync');
});

test('repos run in parallel waves, so one slow draft does not queue the others', async () => {
  const repos = ['w1', 'w2', 'w3'].map((name) => makeRemoteRepo(name));
  for (const { dir } of repos) {
    writeFileSync(join(dir, 'README.md'), 'base\nchanged\n');
  }
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const ctx = fakeCtx(async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      return 'test: parallel';
    } finally {
      inFlight -= 1;
    }
  });

  const job = await runAutosync(ctx, repos.map(({ dir, root }) => ref(root, dir)));

  assert.equal(calls, 3, 'every dirty repo got its own draft');
  assert.equal(job.okCount, 3);
  // A wall-clock bound is flaky on Windows, where spawning git for five stages
  // dominates; assert the property directly — the draft calls overlapped.
  assert.ok(maxInFlight >= 2, `drafts never overlapped (max ${maxInFlight} in flight)`);
});
