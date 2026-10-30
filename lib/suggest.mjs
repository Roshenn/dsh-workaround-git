/**
 * AI commit-message drafts.
 *
 * Uses dsh's own `llm` service, so the plugin never handles provider URLs or
 * API keys: the model route comes from the session default (`agentDefaultModel`)
 * and falls back to the first advertised provider. The result is a draft — the
 * caller puts it in an input box; nothing is committed here.
 *
 * The diff is budgeted before it reaches the model because a single generated
 * lockfile can dwarf every source change in the repo.
 */
import { git } from './git.mjs';

const MAX_DIFF_BYTES = 120 * 1024;
const MAX_OUTPUT_TOKENS = 8000;
const TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  'You write exactly one git commit message for the staged changes of one repository.',
  'Format: a Conventional Commits subject "<type>(<scope>): <subject>" of at most 72 characters, imperative mood, no trailing period.',
  'Then one blank line, then 2-4 bullet points starting with "- " describing what changed and why.',
  'Output only the message: no code fences, no surrounding quotes, no preamble.',
].join(' ');

function truncate(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  let cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > limit * 0.6) cut = cut.slice(0, lastBreak);
  return { text: `${cut}\n… [diff truncated to ${limit} bytes]`, truncated: true };
}

/** Read the change set to describe: the staged diff first, the working diff second. */
export async function collectDiff(repoPath) {
  const [nameStatus, staged, working, untracked, branch, recent] = await Promise.all([
    git(repoPath, ['diff', '--name-status', 'HEAD']),
    git(repoPath, ['diff', '--staged']),
    git(repoPath, ['diff', 'HEAD']),
    git(repoPath, ['ls-files', '--others', '--exclude-standard']),
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['log', '-5', '--pretty=%s']),
  ]);
  const files = nameStatus.ok
    ? nameStatus.stdout.split('\n').filter(Boolean).map((line) => {
      const [state, ...rest] = line.split('\t');
      return { status: state, path: rest.join('\t') };
    })
    : [];
  const untrackedList = untracked.ok ? untracked.stdout.split('\n').filter(Boolean) : [];
  for (const path of untrackedList) files.push({ status: 'A', path, untracked: true });

  const stagedDiff = staged.ok ? staged.stdout : '';
  const workingDiff = working.ok ? working.stdout : '';
  const diff = stagedDiff.trim() !== '' ? stagedDiff : workingDiff;
  const capped = truncate(diff, MAX_DIFF_BYTES);

  return {
    branch: branch.ok && branch.stdout ? branch.stdout : '(detached)',
    files,
    diff: capped.text,
    truncated: capped.truncated,
    recentCommits: recent.ok ? recent.stdout.split('\n').filter(Boolean) : [],
    hasChanges: files.length > 0 || diff.trim() !== '',
  };
}

/** Pick the model route: session default first, then the first advertised provider. */
export function resolveRoute(ctx, llm) {
  try {
    const selection = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined;
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
      && selection.provider !== '' && selection.model !== '') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {},
      };
    }
  } catch {
    // fall through to the catalog
  }
  try {
    const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : undefined;
    const first = Array.isArray(providers) ? providers[0] : undefined;
    const model = Array.isArray(first?.models) ? first.models[0] : undefined;
    if (first && model) {
      return { provider: first.id ?? first.provider ?? first.name, model: model.id ?? model.name };
    }
  } catch {
    // no catalog
  }
  return undefined;
}

function buildPrompt({ repo, branch, files, diff, recentCommits }) {
  const fileLines = files.slice(0, 80).map((file) => {
    const suffix = file.untracked ? ' (new file)' : '';
    return `${file.status}\t${file.path}${suffix}`;
  });
  if (files.length > 80) fileLines.push(`… ${files.length - 80} more files`);
  const style = recentCommits.length > 0 ? `\nRecent commit subjects (match this style):\n${recentCommits.map((s) => `- ${s}`).join('\n')}` : '';
  return [
    `Repository: ${repo}`,
    `Branch: ${branch}`,
    `Files:`,
    fileLines.join('\n') || '(none listed)',
    style,
    '',
    'Diff:',
    diff,
  ].join('\n');
}

/** Strip wrappers models add even when told not to. */
export function normalizeMessage(text) {
  let value = String(text ?? '').trim();
  const fence = value.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) value = fence[1].trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length > 2) value = value.slice(1, -1).trim();
  return value;
}

/**
 * Draft one commit message from the repo's current changes.
 * @returns {Promise<{ok: true, message: string, provider: string, model: string, truncated?: boolean} | {ok: false, error: {code: string, message: string}}>}
 */
export async function suggestMessage(ctx, repoPath, { root, signal } = {}) {
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: { code: 'llm-unavailable', message: 'this dsh build exposes no llm service' } };
  }
  const route = resolveRoute(ctx, llm);
  if (!route) {
    return { ok: false, error: { code: 'llm-route', message: 'no provider/model is configured for the panel' } };
  }

  let collected;
  try {
    collected = await collectDiff(repoPath);
  } catch (error) {
    return { ok: false, error: { code: 'git-error', message: error?.message ?? String(error) } };
  }
  if (!collected.hasChanges) {
    return { ok: false, error: { code: 'empty', message: 'no changes to describe in this repo' } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  let combined = controller.signal;
  if (signal) {
    try {
      combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    } catch {
      combined = controller.signal;
    }
  }

  const messages = [{
    id: 'workaround-git-suggest',
    role: 'user',
    content: [{ type: 'text', text: buildPrompt({ repo: repoPath, ...collected }) }],
    source: { kind: 'user' },
  }];
  const options = {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {},
    system: SYSTEM_PROMPT,
    messages,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    signal: combined,
  };

  let output = '';
  let finishReason;
  try {
    for await (const chunk of llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') output += chunk.text ?? '';
      else if (chunk.type === 'finish') finishReason = chunk.reason ?? chunk.finishReason;
    }
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted === true) return { ok: false, error: { code: 'cancelled', message: 'generation cancelled' } };
    if (controller.signal.aborted) return { ok: false, error: { code: 'timeout', message: `model call timed out after ${TIMEOUT_MS} ms` } };
    return { ok: false, error: { code: 'llm-error', message: error?.message ?? String(error) } };
  }
  clearTimeout(timer);

  const message = normalizeMessage(output);
  if (message === '') {
    return { ok: false, error: { code: 'llm-output', message: `model produced no message${finishReason ? ` (finish: ${finishReason})` : ''}` } };
  }
  return {
    ok: true,
    message,
    provider: route.provider,
    model: route.model,
    ...collected.truncated ? { truncated: true } : {},
  };
}
