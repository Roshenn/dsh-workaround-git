#!/usr/bin/env node
/**
 * Entry-path benchmark for the panel.
 *
 * The panel opens with `GET /api/managed` (one file read) and then
 * `GET /api/state` (one discovery walk plus one snapshot per repository), while
 * the remote check runs in the background. This script measures those two costs
 * on the workspaces this machine actually manages, so a change to the entry
 * path can be judged against a number instead of a feeling.
 *
 * Reads only: `git status` / `rev-parse` / `log` / `remote`, and with `--fetch`
 * a `git ls-remote` network probe (no refs are updated). Nothing is written.
 *
 * Usage: node scripts/bench-panel.mjs [--fetch] [--runs=3]
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { readManaged } from '../lib/store.mjs';
import { managedWorkspacesState } from '../lib/state.mjs';
import { git, repoRemote } from '../lib/git.mjs';

const args = process.argv.slice(2);
const withFetch = args.includes('--fetch');
const runsArg = args.find((arg) => arg.startsWith('--runs='));
const runs = Math.max(1, Number.parseInt(runsArg?.slice('--runs='.length) ?? '3', 10) || 3);

const managed = await readManaged();
if (managed.workspaces.length === 0) {
  console.log('no managed workspaces: open the panel and pick some first');
  process.exit(0);
}

function ms(value) {
  return `${value.toFixed(0)} ms`;
}

const readStart = performance.now();
await readManaged();
console.log(`GET /api/managed (one store read)   ${ms(performance.now() - readStart)}`);

for (let run = 1; run <= runs; run += 1) {
  const start = performance.now();
  const state = await managedWorkspacesState(managed.workspaces);
  const elapsed = performance.now() - start;
  const repos = state.flatMap((workspace) => workspace.repos ?? []);
  const failed = repos.filter((repo) => repo.ok !== true).length;
  console.log(
    `GET /api/state run ${run}                ${ms(elapsed)}  `
    + `(${managed.workspaces.length} workspaces, ${repos.length} repos${failed > 0 ? `, ${failed} failed` : ''})`,
  );
}

if (withFetch) {
  // A relative probe of what the background remote check pays per repository.
  // `ls-remote` has the same network round trip as `fetch` but writes nothing.
  const start = performance.now();
  const rows = await Promise.all(managed.workspaces.map(async (workspace) => {
    const remote = await repoRemote(workspace.path);
    if (!remote.name) return { path: workspace.path, ms: 0, note: 'no remote' };
    const probeStart = performance.now();
    const result = await git(workspace.path, ['ls-remote', '--heads', remote.name], { timeout: 60_000 });
    return { path: workspace.path, ms: performance.now() - probeStart, note: result.ok ? remote.url : result.stderr };
  }));
  console.log(`background remote probe (${rows.length} repos, parallel) ${ms(performance.now() - start)}`);
  for (const row of rows) {
    console.log(`  ${ms(row.ms).padStart(8)}  ${resolve(row.path)}  ${row.note}`);
  }
}
