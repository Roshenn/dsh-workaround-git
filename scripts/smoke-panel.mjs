/**
 * End-to-end smoke for the panel API, without the dsh shell.
 *
 * Builds a throwaway workspace with one git repo, points DSH_HOME at a temp
 * directory whose storage registry lists it, mounts the API handler on a real
 * http server, and walks the same sequence the browser half sends:
 * workspaces → managed → state → stage → suggest → commit, then the file-level
 * actions (stage/unstage paths, diff, history, discard, ignore, stash,
 * branches, switch).
 *
 * The llm service is faked with an async generator so the suggest path is
 * exercised without a provider; the OS opener is not called (it would open a
 * window on the machine running the smoke).
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from '../lib/api.mjs';

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

const home = await mkdtemp(join(tmpdir(), 'wg-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'wg-ws-'));
const rootRepo = await mkdtemp(join(tmpdir(), 'wg-root-'));
const bare = join(home, 'origin.git');
const repo = join(workspace, 'demo');

async function setup() {
  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: {
      workspaces: {
        demo: { title: 'demo', path: workspace },
        root: { title: 'root-repo', path: rootRepo },
      },
    },
  }), 'utf8');

  // A real local remote so /fetch can be exercised end to end.
  sh(home, 'init', '--bare', '-q', 'origin.git');

  await mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'smoke@example.com');
  sh(repo, 'config', 'user.name', 'Smoke');
  await writeFile(join(repo, 'readme.txt'), 'one\n', 'utf8');
  sh(repo, 'add', 'readme.txt');
  sh(repo, 'commit', '-q', '-m', 'chore: initial commit');
  sh(repo, 'remote', 'add', 'origin', bare);
  sh(repo, 'push', '-q', '-u', 'origin', 'HEAD');
  await writeFile(join(repo, 'readme.txt'), 'one\ntwo\n', 'utf8');

  sh(rootRepo, 'init', '-q');
  sh(rootRepo, 'config', 'user.email', 'smoke@example.com');
  sh(rootRepo, 'config', 'user.name', 'Smoke');
  await writeFile(join(rootRepo, 'root.txt'), 'root\n', 'utf8');
}

function fakeLlm() {
  return {
    stream: async function* stream() {
      yield { type: 'text-delta', text: 'feat(panel): add workaround git panel\n\n' };
      yield { type: 'text-delta', text: '- list managed workspaces\n- draft messages with the model\n' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'llm') return fakeLlm();
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
    return undefined;
  },
};

const server = createServer(createApiHandler(ctx));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/workaround-git/api`;

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`${method} ${path} → ${response.status} ${payload.error?.message}`);
  return payload.data;
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name} ${detail}`);
}

const repoBody = { workspaceId: 'demo', repo };

try {
  process.env.DSH_HOME = home;
  await setup();

  const listed = await api('GET', '/workspaces');
  const found = listed.workspaces.find((entry) => entry.path === workspace);
  const foundRoot = listed.workspaces.find((entry) => entry.path === rootRepo);
  check('workspaces lists the temp workspace', found !== undefined && foundRoot !== undefined);
  check('a workspace holding a nested repo is "contains"', found?.git === 'contains', `got ${found?.git}`);
  check('a workspace that is itself a repo is "git"', foundRoot?.git === 'git', `got ${foundRoot?.git}`);

  const saved = await api('POST', '/managed', { workspaces: [{ id: 'demo', path: workspace, title: 'demo' }] });
  check('managed saved', saved.managed.workspaces.length === 1);

  let state = await api('GET', '/state');
  let repoRow = state.workspaces[0]?.repos?.[0];
  check('state reports the repo', repoRow?.repo === 'demo');
  check('state reports the modified file under changes', repoRow?.groups?.changes?.some((file) => file.path === 'readme.txt'), JSON.stringify(repoRow?.groups));
  check('state reports the branch', repoRow?.branch === 'main' || repoRow?.branch === 'master', repoRow?.branch);
  check('state reports the origin remote', repoRow?.remote?.name === 'origin' && repoRow?.remote?.url === bare, JSON.stringify(repoRow?.remote));

  const stagedAll = await api('POST', '/stage', repoBody);
  check('stage all', stagedAll.action === 'staged-all', JSON.stringify(stagedAll));
  state = await api('GET', '/state');
  repoRow = state.workspaces[0]?.repos?.[0];
  check('staged file moves to the staged group', repoRow?.groups?.staged?.some((file) => file.path === 'readme.txt'));

  const draft = await api('POST', '/suggest', repoBody);
  check('suggest returns a message', typeof draft.message === 'string' && draft.message.startsWith('feat(panel)'), JSON.stringify(draft));

  const commit = await api('POST', '/commit', { ...repoBody, message: draft.message });
  check('commit succeeds', commit.ok === true && typeof commit.commit === 'string', JSON.stringify(commit));

  const log = sh(repo, 'log', '-1', '--pretty=%s').trim();
  check('commit landed in the repo', log === 'feat(panel): add workaround git panel', log);

  const pushedOnce = await api('POST', '/push', repoBody);
  check('push updates the remote', pushedOnce.ok === true, JSON.stringify(pushedOnce));

  // ── file-level actions ────────────────────────────────────────────────────
  await writeFile(join(repo, 'new-file.txt'), 'hello\n', 'utf8');
  await writeFile(join(repo, 'readme.txt'), 'one\ntwo\nthree\n', 'utf8');

  const stagedOne = await api('POST', '/stage', { ...repoBody, paths: ['new-file.txt'] });
  check('stage one path', stagedOne.action === 'staged', JSON.stringify(stagedOne));
  state = await api('GET', '/state');
  repoRow = state.workspaces[0]?.repos?.[0];
  check('path staging lands in staged', repoRow?.groups?.staged?.some((file) => file.path === 'new-file.txt'));
  check('unstaged edit stays in changes', repoRow?.groups?.changes?.some((file) => file.path === 'readme.txt'));

  const unstaged = await api('POST', '/unstage', { ...repoBody, paths: ['new-file.txt'] });
  check('unstage one path', unstaged.action === 'unstaged', JSON.stringify(unstaged));
  state = await api('GET', '/state');
  repoRow = state.workspaces[0]?.repos?.[0];
  check('unstage returns it to changes', repoRow?.groups?.changes?.some((file) => file.path === 'new-file.txt'));

  const diff = await api('POST', '/diff', { ...repoBody, path: 'new-file.txt' });
  check('diff of an untracked file is synthetic', diff.untracked === true && /new file/.test(diff.text), diff.text?.slice(0, 80));

  const history = await api('POST', '/history', { ...repoBody, path: 'readme.txt' });
  check('history lists commits', history.commits.length >= 2, JSON.stringify(history.commits?.length));

  const discarded = await api('POST', '/discard', { ...repoBody, paths: ['readme.txt', 'new-file.txt'] });
  check('discard reports both files', discarded.ok === true, JSON.stringify(discarded.results));
  const restored = (await readFile(join(repo, 'readme.txt'), 'utf8')).replace(/\r\n/g, '\n');
  check('discard restored the tracked file', restored === 'one\ntwo\n', JSON.stringify(restored));
  check('discard deleted the untracked file', !existsSync(join(repo, 'new-file.txt')));

  await writeFile(join(repo, 'ignored.tmp'), 'x\n', 'utf8');
  const ignored = await api('POST', '/ignore', { ...repoBody, path: 'ignored.tmp', mode: 'file' });
  const ignoredAgain = await api('POST', '/ignore', { ...repoBody, path: 'ignored.tmp', mode: 'file' });
  check('ignore rule appended once', ignored.added === true && ignoredAgain.added === false, JSON.stringify({ ignored, ignoredAgain }));
  check('gitignore contains the rule', (await readFile(join(repo, '.gitignore'), 'utf8')).includes('/ignored.tmp'));

  await writeFile(join(repo, 'readme.txt'), 'one\ntwo\nfour\n', 'utf8');
  const stashed = await api('POST', '/stash', { ...repoBody, paths: ['readme.txt'] });
  check('stash succeeds', stashed.ok === true, JSON.stringify(stashed));
  check('stash cleaned the worktree', sh(repo, 'status', '--porcelain', '--', 'readme.txt').trim() === '');
  sh(repo, 'stash', 'pop');

  sh(repo, 'branch', 'feature');
  const branches = await api('POST', '/branches', repoBody);
  check('branches lists feature', branches.branches.some((branch) => branch.name === 'feature'), JSON.stringify(branches.branches));
  const switched = await api('POST', '/branch-switch', { ...repoBody, branch: 'feature' });
  check('branch switch works', switched.ok === true, JSON.stringify(switched));
  await api('POST', '/branch-switch', { ...repoBody, branch: repoRow.branch });

  // ── remote update check ───────────────────────────────────────────────────
  const clone = await mkdtemp(join(tmpdir(), 'wg-clone-'));
  sh(home, 'clone', '-q', bare, clone);
  sh(clone, 'config', 'user.email', 'smoke@example.com');
  sh(clone, 'config', 'user.name', 'Smoke');
  await writeFile(join(clone, 'remote-advance.txt'), 'remote\n', 'utf8');
  sh(clone, 'add', '.');
  sh(clone, 'commit', '-q', '-m', 'feat: remote advance');
  sh(clone, 'push', '-q');
  const fetched = await api('POST', '/fetch', {});
  check('fetch runs for every managed repo', fetched.fetched >= 1 && fetched.failed === 0, JSON.stringify(fetched));
  state = await api('GET', '/state');
  repoRow = state.workspaces[0]?.repos?.[0];
  check('state reports the remote advance after fetch', (repoRow?.behind ?? 0) >= 1, JSON.stringify({ behind: repoRow?.behind, ahead: repoRow?.ahead }));
  await rm(clone, { recursive: true, force: true });

  // ── batch pull / push / suggest ───────────────────────────────────────────
  sh(repo, 'restore', '--worktree', '--', 'readme.txt');
  await rm(join(repo, '.gitignore'), { force: true });
  await rm(join(repo, 'ignored.tmp'), { force: true });
  const pulled = await api('POST', '/batch', { action: 'pull' });
  check('batch pull fast-forwards behind repos', pulled.okCount >= 1 && pulled.skippedCount === 0, JSON.stringify(pulled));
  state = await api('GET', '/state');
  repoRow = state.workspaces[0]?.repos?.[0];
  check('batch pull cleared behind', (repoRow?.behind ?? 0) === 0, JSON.stringify({ behind: repoRow?.behind, ahead: repoRow?.ahead }));

  await writeFile(join(repo, 'batch-push.txt'), 'batch\n', 'utf8');
  await api('POST', '/stage', { ...repoBody, paths: ['batch-push.txt'] });
  await api('POST', '/commit', { ...repoBody, message: 'test: batch push' });
  const pushed = await api('POST', '/batch', { action: 'push' });
  check('batch push pushes commits', pushed.okCount >= 1, JSON.stringify(pushed));
  check('remote received the pushed commit', sh(bare, 'log', '-1', '--pretty=%s').trim() === 'test: batch push', sh(bare, 'log', '-1', '--pretty=%s'));

  await writeFile(join(repo, 'draft.txt'), 'draft\n', 'utf8');
  const batchDraft = await api('POST', '/batch', { action: 'suggest' });
  check(
    'batch suggest returns drafts',
    batchDraft.results.some((row) => row.ok && typeof row.message === 'string' && row.message.startsWith('feat(panel)')),
    JSON.stringify(batchDraft.results),
  );

  let refused = null;
  try {
    await api('POST', '/stage', { ...repoBody, paths: ['../outside.txt'] });
  } catch (error) {
    refused = error.message;
  }
  check('a path outside the repo is refused', refused !== null && /inside the repository/.test(refused), refused ?? 'no error');

  // ── workspace that is itself the repository ───────────────────────────────
  await api('POST', '/managed', {
    workspaces: [
      { id: 'demo', path: workspace, title: 'demo' },
      { id: 'root', path: rootRepo, title: 'root-repo' },
    ],
  });
  const selfBranches = await api('POST', '/branches', { workspaceId: 'root', repo: rootRepo });
  check('a workspace that is itself a repo is accepted', selfBranches.ok === true, JSON.stringify(selfBranches));
  await api('POST', '/stage', { workspaceId: 'root', repo: rootRepo, paths: ['root.txt'] });
  const selfCommit = await api('POST', '/commit', { workspaceId: 'root', repo: rootRepo, message: 'test: self repo commit' });
  check('commit works when the repo is the workspace root', selfCommit.action === 'committed', JSON.stringify(selfCommit));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(rootRepo, { recursive: true, force: true });
}

console.log(failures === 0 ? '\npanel smoke: all checks passed' : `\npanel smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
