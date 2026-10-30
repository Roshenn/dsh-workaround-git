/**
 * End-to-end smoke for the panel API, without the dsh shell.
 *
 * Builds a throwaway workspace with one git repo, points DSH_HOME at a temp
 * directory whose storage registry lists it, mounts the API handler on a real
 * http server, and walks the same sequence the browser half sends:
 * workspaces → managed → state → stage → suggest → commit.
 *
 * The llm service is faked with an async generator so the suggest path is
 * exercised without a provider.
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from '../lib/api.mjs';

function sh(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const home = await mkdtemp(join(tmpdir(), 'wg-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'wg-ws-'));
const rootRepo = await mkdtemp(join(tmpdir(), 'wg-root-'));
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

  await mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'smoke@example.com');
  sh(repo, 'config', 'user.name', 'Smoke');
  await writeFile(join(repo, 'readme.txt'), 'one\n', 'utf8');
  sh(repo, 'add', 'readme.txt');
  sh(repo, 'commit', '-q', '-m', 'chore: initial commit');
  await writeFile(join(repo, 'readme.txt'), 'one\ntwo\n', 'utf8');

  sh(rootRepo, 'init', '-q');
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
    if (name === 'workspaceRegistry') return undefined;
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

try {
  process.env.DSH_HOME = home;
  await setup();

  const listed = await api('GET', '/workspaces');
  const found = listed.workspaces.find((entry) => entry.path === workspace);
  const foundRoot = listed.workspaces.find((entry) => entry.path === rootRepo);
  check('workspaces lists the temp workspace', found !== undefined && foundRoot !== undefined);
  check('a workspace holding a nested repo is "contains"', found?.git === 'contains', `got ${found?.git}`);
  check('a workspace that is itself a repo is "git"', foundRoot?.git === 'git', `got ${foundRoot?.git}`);
  check('workspace lists the repo', found?.repos?.[0]?.label === 'demo', JSON.stringify(found?.repos));

  const saved = await api('POST', '/managed', { workspaces: [{ id: 'demo', path: workspace, title: 'demo' }] });
  check('managed saved', saved.managed.workspaces.length === 1);

  const state = await api('GET', '/state');
  const repoRow = state.workspaces[0]?.repos?.[0];
  check('state reports the repo', repoRow?.repo === 'demo');
  check('state reports the modified file', repoRow?.files?.some((file) => file.path === 'readme.txt'), JSON.stringify(repoRow?.files));
  check('state reports the branch', repoRow?.branch === 'main' || repoRow?.branch === 'master', repoRow?.branch);

  const staged = await api('POST', '/stage', { workspaceId: 'demo', repo: repoRow.path });
  check('stage stages the change', staged.files.some((line) => line.includes('readme.txt')), JSON.stringify(staged.files));

  const draft = await api('POST', '/suggest', { workspaceId: 'demo', repo: repoRow.path });
  check('suggest returns a message', typeof draft.message === 'string' && draft.message.startsWith('feat(panel)'), JSON.stringify(draft));

  const commit = await api('POST', '/commit', { workspaceId: 'demo', repo: repoRow.path, message: draft.message });
  check('commit succeeds', commit.ok === true && typeof commit.commit === 'string', JSON.stringify(commit));

  const log = execFileSync('git', ['-C', repo, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
  check('commit landed in the repo', log === 'feat(panel): add workaround git panel', log);

  let refused = null;
  try {
    await api('POST', '/stage', { workspaceId: 'demo', repo: join(workspace, '..', 'elsewhere') });
  } catch (error) {
    refused = error.message;
  }
  check('a repo outside the workspace is refused', refused !== null && /inside the managed workspace|not a git repository/.test(refused), refused ?? 'no error');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(rootRepo, { recursive: true, force: true });
}

console.log(failures === 0 ? '\npanel smoke: all checks passed' : `\npanel smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
