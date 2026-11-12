/**
 * One-click sync: the five batch actions as ONE job, executed in parallel waves.
 *
 * Per repository the pipeline is: fetch -> draft + commit -> rebase -> push.
 * A sequential per-repo loop made the batch wait for the slowest repo N times
 * (one model call per dirty repo, queued two at a time); a wave pipeline runs
 * every repo's `fetch` at once, then every draft at once, and so on, so the wall
 * clock is the slowest single repo rather than their sum.
 *
 * Wave 1 can be skipped entirely when the panel's background remote check ran
 * less than `FETCH_REUSE_MS` ago (`noteRemoteFetch` records it): the refs are
 * already current, and fetching twelve remotes again costs seconds.
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

/** The five per-repo stages, in order. The panel renders one dot per entry. */
export const STAGES = ['fetch', 'draft', 'commit', 'merge', 'push'];

export const STAGE_LABELS = {
  fetch: '抓取',
  draft: '生成',
  commit: '提交',
  merge: '合并',
  push: '推送',
};

/**
 * How long a remote check stays fresh enough to reuse. The panel fetches on
 * open and on 刷新; clicking sync within this window reuses those refs instead
 * of paying for a second network round trip across every repository.
 */
export const FETCH_REUSE_MS = 15_000;

/** Finished jobs stay readable this long so a late poll still sees the result. */
const JOB_TTL_MS = 10 * 60_000;

let lastRemoteFetchAt = 0;

/** Record that every managed repository was just fetched from its remote. */
export function noteRemoteFetch(at = Date.now()) {
  lastRemoteFetchAt = at;
}

export function getRemoteFetchAt() {
  return lastRemoteFetchAt;
}

// ── job state ───────────────────────────────────────────────────────────────

const jobs = new Map();
let jobSeq = 0;

function makeRow(ref) {
  return {
    workspace: ref.workspacePath,
    repo: ref.repoPath,
    repoPath: ref.repoPath,
    label: ref.label || repoLabel(ref.repoPath, ref.workspacePath),
    state: 'pending',
    stage: null,
    stageIndex: -1,
    steps: Object.fromEntries(STAGES.map((stage) => [stage, 'pending'])),
    ms: {},
    action: null,
    error: null,
    message: null,
    commit: null,
    branch: null,
    reused: false,
    // Internal only, stripped from the snapshot.
    blocked: false,
    pendingChanges: 0,
  };
}

function isSettled(row) {
  return row.state === 'done' || row.state === 'skipped' || row.state === 'failed';
}

/** Mark one step as running and time it until the work resolves. */
async function step(row, stage, work) {
  row.stage = stage;
  row.stageIndex = STAGES.indexOf(stage);
  row.state = 'active';
  row.steps[stage] = 'active';
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    row.ms[stage] = Date.now() - startedAt;
  }
}

/** The row stops here: keep whatever steps already ran, grey out the rest. */
function settle(row, state, action, error = null) {
  row.state = state;
  row.action = action;
  row.error = error;
  row.blocked = state !== 'done';
  row.stage = null;
  row.stageIndex = -1;
  for (const stage of STAGES) {
    if (row.steps[stage] === 'pending' || row.steps[stage] === 'active') row.steps[stage] = 'skipped';
  }
}

function tally(job) {
  const rows = job.rows;
  job.doneCount = rows.filter(isSettled).length;
  job.okCount = rows.filter((row) => row.state === 'done' && row.action === 'synced').length;
  job.skippedCount = rows.filter((row) => row.state === 'skipped').length;
  job.failedCount = rows.filter((row) => row.state === 'failed').length;
}

function snapshot(job) {
  tally(job);
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    reusedFetch: job.reusedFetch,
    total: job.rows.length,
    doneCount: job.doneCount,
    okCount: job.okCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    rows: job.rows.map((row) => ({
      workspace: row.workspace,
      repo: row.repo,
      repoPath: row.repoPath,
      label: row.label,
      state: row.state,
      stage: row.stage,
      stageIndex: row.stageIndex,
      steps: { ...row.steps },
      ms: { ...row.ms },
      action: row.action,
      error: row.error,
      message: row.message,
      commit: row.commit,
      branch: row.branch,
      reused: row.reused,
    })),
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

// ── waves ───────────────────────────────────────────────────────────────────

/** Every repo starts clean: no unfinished operation, no conflict, has a remote. */
async function wavePreflight(job) {
  await Promise.all(job.rows.map(async (row) => {
    const status = await repoStatus(row.repoPath, { root: row.workspace });
    if (!status.ok) {
      row.steps.fetch = 'failed';
      settle(row, 'failed', 'status-failed', status.error);
      return;
    }
    row.branch = status.branch;
    if (status.sequencer !== null) {
      settle(row, 'skipped', 'sequencer-active', `${status.sequencer} 未完成：先完成或中止它再同步`);
      return;
    }
    if (status.conflicted > 0) {
      settle(row, 'skipped', 'conflicts', `${status.conflicted} 个冲突文件未解决`);
      return;
    }
    const remote = await repoRemote(row.repoPath);
    if (!remote.url) {
      settle(row, 'skipped', 'no-remote', '仓库没有配置 remote');
      return;
    }
    row.pendingChanges = status.staged + status.modified + status.untracked;
  }));
}

/**
 * Fetch and compose run at the same time for every repo.
 *
 * The network round trip and the model call are independent — the draft reads
 * the local diff, the fetch only moves remote refs — so a repo waits for the
 * slower of the two instead of their sum. That is the difference between a
 * cold click costing ~10s and ~7s on a twelve-repo workspace.
 *
 * Both halves always resolve, and the row is settled afterwards in pipeline
 * order, so a fetch failure and a draft failure can never overwrite each other.
 */
async function waveCarry(ctx, job) {
  await Promise.all(job.rows.map(async (row) => {
    if (row.blocked) return;

    let fetchError = null;
    const fetchWork = (async () => {
      if (job.reusedFetch) {
        row.steps.fetch = 'done';
        row.reused = true;
        row.ms.fetch = 0;
        return;
      }
      const fetched = await step(row, 'fetch', () => fetchRepo(row.repoPath));
      if (!fetched.ok) {
        row.steps.fetch = 'failed';
        fetchError = fetched.error;
        return;
      }
      row.steps.fetch = 'done';
    })();

    let draftError = null;
    let commitFailure = null;
    const composeWork = (async () => {
      if (row.pendingChanges === 0) {
        row.steps.draft = 'skipped';
        row.steps.commit = 'skipped';
        return;
      }
      const draft = await step(row, 'draft', () => suggestMessage(ctx, row.repoPath, { root: row.workspace }));
      if (!draft.ok) {
        // The user chose "keep waiting for the model" over a placeholder: a repo
        // whose draft fails is skipped rather than committed with invented text.
        row.steps.draft = 'failed';
        draftError = draft.error?.message ?? '模型没有返回提交信息';
        return;
      }
      row.steps.draft = 'done';
      row.message = draft.message;

      const result = await step(row, 'commit', async () => {
        const staged = await stagePaths(row.repoPath, []);
        if (!staged.ok) return { ok: false, action: 'stage-failed', error: staged.error };
        return commitRepo(row.repoPath, draft.message, { root: row.workspace, addAll: false });
      });
      if (result.ok === false) {
        row.steps.commit = 'failed';
        commitFailure = { action: result.action ?? 'commit-failed', error: result.error };
        return;
      }
      row.steps.commit = 'done';
      row.commit = result.commit ?? null;
      row.message = result.message ?? draft.message;
    })();

    await Promise.all([fetchWork, composeWork]);

    // Settle in pipeline order. A failed fetch ends the repo even when the local
    // commit already landed: the commit is real local work, but nothing can be
    // merged or pushed without the remote refs.
    if (fetchError !== null) {
      settle(row, 'failed', 'fetch-failed', fetchError);
      return;
    }
    if (draftError !== null) {
      settle(row, 'skipped', 'no-message', draftError);
      return;
    }
    if (commitFailure !== null) {
      settle(row, 'failed', commitFailure.action, commitFailure.error);
      return;
    }
    row.state = 'pending';
    row.stage = null;
  }));
}

/** Integrate the remote. Wave 1 already fetched, so no second fetch here. */
async function waveMerge(job) {
  await Promise.all(job.rows.map(async (row) => {
    if (row.blocked) return;
    const merged = await step(row, 'merge', () => syncRepo(row.repoPath, {
      root: row.workspace,
      mode: AUTOSYNC_MERGE_MODE,
      fetchFirst: false,
    }));
    if (merged.ok === false) {
      // A conflicted rebase leaves the repo on `rebase-merge` / `rebase-apply`;
      // report it as such (the panel shows the conflict lane) and never push.
      const sequencer = await repoSequencer(row.repoPath);
      row.steps.merge = 'failed';
      settle(row, 'failed', sequencer === 'rebase' ? 'rebase-conflict' : (merged.action ?? 'merge-failed'), merged.error);
      return;
    }
    row.steps.merge = 'done';
    row.state = 'pending';
    row.stage = null;
  }));
}

/** Push only repos that are ahead; everything else has nothing to send. */
async function wavePush(job) {
  await Promise.all(job.rows.map(async (row) => {
    if (row.blocked) return;
    const status = await repoStatus(row.repoPath, { root: row.workspace });
    if (!status.ok) {
      row.steps.push = 'failed';
      settle(row, 'failed', 'status-failed', status.error);
      return;
    }
    row.branch = status.branch;
    if (!status.upstream) {
      settle(row, 'skipped', 'no-upstream', '当前分支没有 upstream，未推送');
      return;
    }
    if ((status.ahead ?? 0) === 0) {
      row.steps.push = 'done';
      settle(row, 'done', 'synced');
      return;
    }
    // `setUpstream: false`: one-click sync must not publish a new remote branch.
    const pushed = await step(row, 'push', () => pushRepo(row.repoPath, { root: row.workspace, setUpstream: false }));
    if (!pushed.ok) {
      row.steps.push = 'failed';
      settle(row, 'failed', 'push-failed', pushed.error);
      return;
    }
    row.steps.push = 'done';
    settle(row, 'done', 'synced');
  }));
}

async function runJob(ctx, job) {
  try {
    await wavePreflight(job);
    await waveCarry(ctx, job);
    await waveMerge(job);
    await wavePush(job);
  } catch (error) {
    // A wave must never leave the job "running" forever: any unexpected throw
    // settles the repos it had not finished yet and marks the job done.
    for (const row of job.rows) {
      if (!isSettled(row)) settle(row, 'failed', 'internal-error', error?.message ?? String(error));
    }
  } finally {
    job.finishedAt = Date.now();
    job.status = 'done';
    tally(job);
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Start (or join) the running job for these refs.
 *
 * Returns immediately with a snapshot whose `status` is `running`; the caller
 * polls `getAutosyncJob(id)` for per-repo, per-stage progress. A second call
 * while a job is running returns that same job instead of starting a competing
 * one on the same repositories.
 */
export function startAutosync(ctx, refs) {
  for (const job of jobs.values()) {
    if (job.status === 'running') return snapshot(job);
  }
  pruneJobs();
  const id = `${Date.now().toString(36)}-${(++jobSeq).toString(36)}`;
  const job = {
    id,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    // Decided once, up front, so the first snapshot the panel sees already says
    // whether this run is paying for the network.
    reusedFetch: lastRemoteFetchAt > 0 && Date.now() - lastRemoteFetchAt <= FETCH_REUSE_MS,
    rows: refs.map(makeRow),
    doneCount: 0,
    okCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };
  jobs.set(id, job);
  void runJob(ctx, job);
  return snapshot(job);
}

/** Progress snapshot for one job, or null when it never existed / expired. */
export function getAutosyncJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

/** Run the pipeline and resolve once it is finished (tests, smoke, scripts). */
export async function runAutosync(ctx, refs) {
  const started = startAutosync(ctx, refs);
  const job = jobs.get(started.id);
  if (!job) return started;
  while (job.status === 'running') {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return snapshot(job);
}
