/**
 * Rendering for tool output.
 *
 * The consumer is a model reading a tool result, so: one table per batch, no
 * decoration, and every failure visible in the same view as the successes.
 */

const MAX_ROWS = 40;

function cell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(header, rows) {
  const head = `| ${header.map(cell).join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function truncate(rows) {
  if (rows.length <= MAX_ROWS) return { rows, hidden: 0 };
  return { rows: rows.slice(0, MAX_ROWS), hidden: rows.length - MAX_ROWS };
}

function hiddenNote(hidden) {
  return hidden ? `\n\n_${hidden} more repos not shown (raise \`maxDepth\` or narrow \`root\`)._` : '';
}

function counts(rows, key) {
  const map = new Map();
  for (const r of rows) map.set(r[key] ?? 'unknown', (map.get(r[key] ?? 'unknown') ?? 0) + 1);
  return map;
}

function summaryLine(rows, keys) {
  const parts = [];
  for (const key of keys) {
    const map = counts(rows, key);
    if (map.size === 0) continue;
    const totals = [...map.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}: ${n}`);
    if (totals.length) parts.push(totals.join(', '));
  }
  return parts.join(' · ');
}

/** Status overview. */
export function formatStatus({ root, rows }) {
  if (!rows.length) {
    return `No git repos found under \`${root}\`.\n\nPass a wider \`root\`, or raise \`maxDepth\` (default 3).`;
  }
  const { rows: shown, hidden } = truncate(rows);
  const body = shown.map((r) => {
    if (!r.ok) return [r.repo, 'ERROR', '—', '—', r.error];
    const sync = r.ahead === null || r.behind === null
      ? (r.upstream ? '—' : 'no upstream')
      : `↑${r.ahead} ↓${r.behind}`;
    const dirty = r.dirty
      ? [r.staged && `${r.staged} staged`, r.modified && `${r.modified} mod`, r.untracked && `${r.untracked} untracked`, r.conflicted && `${r.conflicted} conflict`]
        .filter(Boolean).join(', ')
      : 'clean';
    return [r.repo, r.branch, dirty, sync, r.lastCommit ? `${r.lastCommit.hash} ${r.lastCommit.subject}` : '—'];
  });
  const dirty = rows.filter((r) => r.ok && r.dirty).length;
  const errored = rows.filter((r) => !r.ok).length;
  const behind = rows.filter((r) => r.ok && r.behind > 0).length;
  const head = [
    `**${rows.length} repos** under \`${root}\``,
    `${dirty} dirty`,
    `${behind} behind`,
    errored ? `${errored} error` : null,
  ].filter(Boolean).join(' · ');
  return `${head}\n\n${table(['repo', 'branch', 'working tree', 'ahead/behind', 'last commit'], body)}${hiddenNote(hidden)}`;
}

/** Per-repo change digest used to write one commit message per repo. */
export function formatChanges({ root, rows }) {
  const withChanges = rows.filter((r) => r.ok && r.hasChanges);
  if (!withChanges.length) return `No uncommitted changes in any of the ${rows.length} repos under \`${root}\`.`;

  const blocks = withChanges.slice(0, MAX_ROWS).map((r) => {
    const files = r.files.slice(0, 15).map((f) => `  - \`${f.path}\` (${f.status})`).join('\n');
    const more = r.fileCount > 15 ? `\n  - _...${r.fileCount - 15} more files_` : '';
    const style = r.recentCommits.length ? `\n  message style: ${r.recentCommits.slice(0, 3).map((s) => `"${s}"`).join(', ')}` : '';
    return `### ${r.repo} (${r.branch})\n+${r.added} −${r.removed} across ${r.fileCount} file(s)\n${files}${more}${style}`;
  });
  const skipped = rows.filter((r) => r.ok && !r.hasChanges).map((r) => r.repo);
  const tail = skipped.length ? `\n\n**Clean repos** (no message needed): ${skipped.join(', ')}` : '';
  return `# Changes per repo\n\nWrite **one message per repo** from its own diff, then call \`git_workspace_commit\` with a map.\n\n${blocks.join('\n\n')}${tail}`;
}

/** Batch sync result. */
export function formatSync({ root, rows }) {
  if (!rows.length) return `No git repos found under \`${root}\`.`;
  const { rows: shown, hidden } = truncate(rows);
  const body = shown.map((r) => [
    r.repo,
    r.action,
    r.ok ? 'ok' : (r.action === 'skipped' ? 'skipped' : 'failed'),
    r.ahead === null || r.ahead === undefined ? '—' : `↑${r.ahead} ↓${r.behind ?? 0}`,
    r.ok ? (r.stdout || r.note || '') : r.error,
  ]);
  const head = `**sync** · ${rows.length} repos · ${summaryLine(rows, ['action'])}`;
  return `${head}\n\n${table(['repo', 'action', 'status', 'after', 'detail'], body)}${hiddenNote(hidden)}`;
}

/** Batch commit result. */
export function formatCommit({ root, rows, skipped = [], unknownKeys = [] }, { dryRun = false } = {}) {
  if (!rows.length) {
    const why = skipped.length ? `No messages supplied for: ${skipped.join(', ')}.` : `No repos with changes under \`${root}\`.`;
    return `${why}\n\nCall \`git_changes_all\` first, then pass a \`messages\` map keyed by repo label.`;
  }
  const { rows: shown, hidden } = truncate(rows);
  const body = shown.map((r) => [
    r.repo,
    r.action,
    r.ok ? (dryRun ? 'dry-run' : 'ok') : 'failed',
    r.commit ?? (r.files ? `${r.files} file(s)` : '—'),
    r.ok ? (r.message ?? '') : r.error,
  ]);
  const head = `**commit** · ${rows.length} repos · ${summaryLine(rows, ['action'])}`;
  const notes = [];
  if (skipped.length) notes.push(`Skipped (no message given): ${skipped.join(', ')}`);
  if (unknownKeys.length) notes.push(`Unknown repo keys (ignored): ${unknownKeys.join(', ')}`);
  return `${head}\n\n${table(['repo', 'action', 'status', 'commit', 'message'], body)}${hiddenNote(hidden)}${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
}

/** Batch push result. */
export function formatPush({ root, rows }) {
  if (!rows.length) return `No git repos found under \`${root}\`.`;
  const { rows: shown, hidden } = truncate(rows);
  const body = shown.map((r) => [
    r.repo,
    r.action,
    r.ok ? 'ok' : 'failed',
    r.branch ?? '—',
    r.ok ? (r.stdout || '') : r.error,
  ]);
  const head = `**push** · ${rows.length} repos · ${summaryLine(rows, ['action'])}`;
  return `${head}\n\n${table(['repo', 'action', 'status', 'branch', 'detail'], body)}${hiddenNote(hidden)}`;
}
