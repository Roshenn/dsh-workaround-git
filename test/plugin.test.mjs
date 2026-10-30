/**
 * Plugin wiring: the host half registers five tools and executes against the
 * session workspace resolved through `workingDirectory`.
 *
 * `@deepseek-ai/dsh-tools` is a peer dependency supplied by the harness, so the
 * test swaps in a contract stub through a loader hook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { makeWorkspace } from './fixtures.mjs';

register('./stub/loader.mjs', import.meta.url);

const plugin = await import('../lib/index.js');

const ws = makeWorkspace();
test.after(() => ws.dispose());

function mount(root) {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    workingDirectory: {
      async ensure() {
        return root;
      },
    },
  };
  plugin.apply(ctx, {});
  return registered;
}

const exec = () => ({ agent: {}, signal: new AbortController().signal });

test('plugin exports the cordis contract', () => {
  assert.equal(plugin.name, 'dsh-workaround-git');
  assert.deepEqual(plugin.inject, ['tools', 'workingDirectory']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the five git_workspace_* tools', () => {
  const tools = mount(ws.root);
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'git_workspace_changes',
      'git_workspace_commit',
      'git_workspace_push',
      'git_workspace_status',
      'git_workspace_sync',
    ],
  );
  for (const definition of tools.values()) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20, `${definition.name} needs a real description`);
    assert.equal(typeof definition.output.render, 'function');
  }
});

test('git_workspace_status resolves the session workspace and renders text', async () => {
  const tools = mount(ws.root);
  const tool = tools.get('git_workspace_status');
  const value = await tool.execute({}, exec());

  assert.equal(value.ok, true);
  assert.ok(value.repos.includes('app-dirty'), `repos: ${value.repos.join(', ')}`);
  assert.match(value.text, /\| repo \| branch \|/);

  const blocks = tool.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, value.text);
});

test('git_workspace_status accepts an explicit root', async () => {
  const tools = mount(process.cwd());
  const value = await tools.get('git_workspace_status').execute({ root: ws.root }, exec());
  assert.ok(value.repos.length >= 5);
});

test('git_workspace_commit commits per-repo messages and reports unknown keys', async () => {
  writeFileSync(`${ws.paths.dirty}/plugin-test.txt`, 'x\n');
  const tools = mount(ws.root);
  const value = await tools.get('git_workspace_commit').execute({
    messages: { 'app-dirty': 'test: plugin path commit', typo: 'test: nope' },
    dryRun: true,
  }, exec());

  assert.match(value.text, /would-commit/);
  assert.match(value.text, /Unknown repo keys/);
  assert.equal(value.ok, true);
});

test('git_workspace_sync dry run does not touch repos', async () => {
  const tools = mount(ws.root);
  const value = await tools.get('git_workspace_sync').execute({ dryRun: true }, exec());
  assert.match(value.text, /would-sync/);
});

test('non-agent callers fall back to process.cwd()', async () => {
  const tools = mount(ws.root);
  const value = await tools.get('git_workspace_status').execute({}, { signal: new AbortController().signal });
  assert.equal(typeof value.text, 'string');
});
