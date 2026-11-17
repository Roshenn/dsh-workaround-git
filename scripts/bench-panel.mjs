#!/usr/bin/env node
/**
 * Entry-path benchmark for the panel.
 *
 * The panel opens with `GET /api/managed` (one file read) and then
 * `GET /api/state` (one discovery walk plus one snapshot per repository), while
 * the remote check runs in the background. This script measures those costs on
 * the workspaces this machine actually manages, so a change to the entry path
 * can be judged against a number instead of a feeling.
 *
 * Three modes, all read-only — `git status` / `rev-parse` / `log` / `diff
 * --numstat` / `remote`, plus (with `--fetch`) a `git ls-remote` network probe
 * that updates no refs, and (with `--http`) GETs only:
 *
 *   node scripts/bench-panel.mjs                end to end, per run
 *   node scripts/bench-panel.mjs --breakdown    + discovery per workspace and
 *                                                 one snapshot + one command
 *                                                 breakdown per repository
 *   node scripts/bench-panel.mjs --http         p50/p95 of the live panel API
 *
 * Flags: `--runs=N` (default 3), `--json` (machine-readable, for before/after
 * diffs), `--fetch`, `--workspace=<id|path>`, `--base=<url>` (default
 * `$DSH_WEB_URL` + `/workaround-git/api`). Nothing is written anywhere.
 */
import { performance } from 'node:perf_hooks';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readManaged } from '../lib/store.mjs';
import { managedWorkspacesState } from '../lib/state.mjs';
import {
  discoverRepos,
  git,
  gitSpawnStats,
  repoRemote,
  repoSnapshot,
  resetGitSpawnStats,
} from '../lib/git.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 1);
};

const runsArg = valueOf('--runs');
const runs = Math.max(1, Number.parseInt(runsArg ?? '3', 10) || 3);
const withBreakdown = has('--breakdown');
const withFetch = has('--fetch');
const asJson = has('--json');
const httpMode = has('--http');
const onlyWorkspace = valueOf('--workspace');
const base = (
  valueOf('--base')
  ?? `${(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:63890').replace(/\/+$/, '')}/workaround-git/api`
).replace(/\/+$/, '');

/** How many repositories get the per-command breakdown (they cost extra spawns). */
const COMMAND_SAMPLE = 10;

function ms(value) {
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ms`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function timed(work) {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
}

// ── live API mode ───────────────────────────────────────────────────────────

async function requestJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, bytes: Buffer.byteLength(text), text };
}

async function runHttp() {
  const health = await requestJson(`${base}/health`);
  if (health.json === null || health.json.ok !== true) {
    console.error(`panel API is not answering JSON at ${base} (HTTP ${health.status})`);
    console.error('  open the panel once so the route mounts, or pass --base=<url>');
    process.exitCode = 1;
    return;
  }

  const managedTimes = [];
  const stateTimes = [];
  let managedBytes = 0;
  let stateBytes = 0;
  let repos = 0;
  for (let run = 1; run <= runs; run += 1) {
    const managed = await timed(() => requestJson(`${base}/managed`));
    managedTimes.push(managed.ms);
    managedBytes = Math.max(managedBytes, managed.value.bytes);
    const state = await timed(() => requestJson(`${base}/state`));
    stateTimes.push(state.ms);
    stateBytes = Math.max(stateBytes, state.value.bytes);
    const rows = (state.value.json?.data?.workspaces ?? []).flatMap((workspace) => workspace.repos ?? []);
    repos = rows.length;
  }

  const managedStats = summarize(managedTimes);
  const stateStats = summarize(stateTimes);
  if (asJson) {
    console.log(JSON.stringify({
      mode: 'http',
      base,
      runs,
      repos,
      managed: { ...managedStats, bytes: managedBytes },
      state: { ...stateStats, bytes: stateBytes },
    }, null, 2));
    return;
  }
  console.log(`GET /api/managed   p50 ${ms(managedStats.p50)} · p95 ${ms(managedStats.p95)} · max ${ms(managedStats.max)} · ${kb(managedBytes)}  (${runs} runs)`);
  console.log(`GET /api/state     p50 ${ms(stateStats.p50)} · p95 ${ms(stateStats.p95)} · max ${ms(stateStats.max)} · ${kb(stateBytes)}  (${runs} runs, ${repos} repos)`);
}

// ── local mode ──────────────────────────────────────────────────────────────

/** One repository's individual git calls, so a slow snapshot can be attributed. */
async function commandBreakdown(repoPath, dirty) {
  const parts = {};
  const step = async (name, call) => {
    const result = await timed(call);
    parts[name] = result.ms;
    return result.value;
  };
  await step('revParse', () => git(repoPath, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-dir']));
  await step('status', () => git(repoPath, ['status', '--porcelain=v2', '--branch', '-z', '--', '.']));
  await step('log', () => git(repoPath, ['log', '-1', '--pretty=%h%x09%s%x09%cr']));
  if (dirty) await step('numstat', () => git(repoPath, ['diff', '--numstat', '--relative', 'HEAD', '--', '.']));
  await step('remoteCached', () => repoRemote(repoPath));
  await step('remoteFresh', () => repoRemote(repoPath, { fresh: true }));
  return { path: repoPath, dirty, ...parts };
}

/**
 * Per-workspace discovery and per-repository snapshots, measured the same way
 * `GET /api/state` runs them (maxDepth 2, hidden cards excluded).
 */
async function breakdown(workspaces, managed) {
  const hidden = new Set(managed.hiddenRepos.map(canonical));
  const workspaceRows = [];
  const commandRows = [];
  let commandCapped = false;

  for (const workspace of workspaces) {
    const discovered = await timed(() => discoverRepos(workspace.path, { maxDepth: 2 }));
    const row = {
      path: workspace.path,
      title: workspace.title ?? '',
      discoverMs: discovered.ms,
      discovered: discovered.value.length,
      repos: [],
    };
    for (const repoPath of discovered.value) {
      if (hidden.has(canonical(repoPath))) continue;
      resetGitSpawnStats();
      const snapshot = await timed(() => repoSnapshot(repoPath, { root: workspace.path }));
      row.repos.push({
        path: repoPath,
        ms: snapshot.ms,
        ok: snapshot.value.ok !== false,
        dirty: snapshot.value.dirty === true,
        spawns: gitSpawnStats().count,
      });
      if (commandRows.length < COMMAND_SAMPLE) {
        commandRows.push(await commandBreakdown(repoPath, snapshot.value.dirty === true));
      } else {
        commandCapped = true;
      }
    }
    workspaceRows.push(row);
  }
  return { workspaces: workspaceRows, commands: commandRows, commandCapped };
}

function printBreakdown(report) {
  console.log('breakdown');
  for (const workspace of report.workspaces) {
    console.log(`  workspace  ${workspace.title || workspace.path}`);
    console.log(`             discover ${ms(workspace.discoverMs)} · ${workspace.discovered} found · ${workspace.repos.length} card(s)`);
    for (const repo of workspace.repos) {
      console.log(`    repo     ${repo.path}  ${ms(repo.ms)} · ${repo.spawns} spawns${repo.dirty ? ' · dirty' : ''}${repo.ok ? '' : ' · failed'}`);
    }
  }
  if (report.commands.length > 0) {
    console.log(`  commands (${report.commands.length} repo(s)${report.commandCapped ? `, capped at ${COMMAND_SAMPLE}` : ''})`);
    for (const row of report.commands) {
      const parts = [
        `rev-parse ${ms(row.revParse)}`,
        `status ${ms(row.status)}`,
        `log ${ms(row.log)}`,
        row.numstat === undefined ? 'numstat —' : `numstat ${ms(row.numstat)}`,
        `remote ${ms(row.remoteCached)} cached / ${ms(row.remoteFresh)} fresh`,
      ];
      console.log(`    ${row.path}`);
      console.log(`      ${parts.join(' · ')}`);
    }
  }
  const slowest = report.workspaces
    .flatMap((workspace) => workspace.repos)
    .sort((a, b) => b.ms - a.ms)[0];
  if (slowest !== undefined) console.log(`  slowest repo  ${slowest.path}  ${ms(slowest.ms)}`);
}

async function runLocal() {
  const read = await timed(() => readManaged());
  const managed = read.value;
  let workspaces = managed.workspaces;
  if (onlyWorkspace !== undefined) {
    const wanted = resolve(onlyWorkspace);
    workspaces = workspaces.filter((workspace) => workspace.id === onlyWorkspace || resolve(workspace.path) === wanted);
    if (workspaces.length === 0) {
      console.error(`no managed workspace matches ${onlyWorkspace}`);
      process.exitCode = 1;
      return;
    }
  }
  if (workspaces.length === 0) {
    if (asJson) console.log(JSON.stringify({ mode: 'local', managed: { ms: read.ms, workspaces: 0 }, state: [] }, null, 2));
    else console.log('no managed workspaces: open the panel and pick some first');
    return;
  }

  const report = {
    mode: 'local',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    runs,
    filter: onlyWorkspace ?? null,
    managed: { ms: read.ms, workspaces: workspaces.length, hiddenRepos: managed.hiddenRepos.length },
    state: [],
    breakdown: null,
    fetch: null,
  };

  if (!asJson) console.log(`GET /api/managed (one store read)   ${ms(read.ms)}`);
  if (withBreakdown) {
    report.breakdown = await breakdown(workspaces, managed);
    if (!asJson) printBreakdown(report.breakdown);
  }

  for (let run = 1; run <= runs; run += 1) {
    resetGitSpawnStats();
    const state = await timed(() => managedWorkspacesState(workspaces, { hiddenRepos: managed.hiddenRepos }));
    const rows = state.value.flatMap((workspace) => workspace.repos ?? []);
    const sample = {
      run,
      ms: state.ms,
      repos: rows.length,
      failed: rows.filter((repo) => repo.ok !== true).length,
      spawns: gitSpawnStats().count,
      bytes: Buffer.byteLength(JSON.stringify(state.value)),
    };
    report.state.push(sample);
    if (!asJson) {
      console.log(
        `GET /api/state run ${run}`.padEnd(28)
        + `${ms(sample.ms).padStart(9)}  `
        + `(${workspaces.length} workspaces, ${sample.repos} repos`
        + `${sample.failed > 0 ? `, ${sample.failed} failed` : ''}, ${sample.spawns} spawns, ${kb(sample.bytes)})`,
      );
    }
  }

  if (withFetch) {
    // A relative probe of what the background remote check pays per repository.
    // `ls-remote` has the same network round trip as `fetch` but writes nothing.
    const hidden = new Set(managed.hiddenRepos.map(canonical));
    const targets = [];
    for (const workspace of workspaces) {
      for (const repoPath of await discoverRepos(workspace.path, { maxDepth: 2 })) {
        if (!hidden.has(canonical(repoPath))) targets.push(repoPath);
      }
    }
    const probe = await timed(() => Promise.all(targets.map(async (repoPath) => {
      const remote = await repoRemote(repoPath);
      if (!remote.name) return { path: repoPath, ms: 0, note: 'no remote' };
      const result = await timed(() => git(repoPath, ['ls-remote', '--heads', remote.name], { timeout: 60_000 }));
      return { path: repoPath, ms: result.ms, note: result.value.ok ? remote.url : result.value.stderr };
    })));
    report.fetch = { ms: probe.ms, rows: probe.value };
    if (!asJson) {
      console.log(`background remote probe (${targets.length} repos, parallel) ${ms(probe.ms)}`);
      for (const row of probe.value) console.log(`  ${ms(row.ms).padStart(8)}  ${resolve(row.path)}  ${row.note}`);
    }
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
}

if (httpMode) await runHttp();
else await runLocal();
