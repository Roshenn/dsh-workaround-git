/**
 * Test fixtures: a throwaway multi-repo workspace, each project with its own
 * bare origin (separate remotes so concurrent pushes cannot race on one ref).
 *
 * Shape (all under one temp root):
 *   remotes/<name>.git     bare origin per project
 *   app                    clean and up to date
 *   app-dirty              modified + untracked files
 *   app-behind             origin moved forward by one commit, fetched but not pulled
 *   app-ahead              one local-only commit
 *   app-nested/deep        clean, at depth 2 (for maxDepth coverage)
 *   node_modules/skipme    must never be discovered
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

export function run(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dshwg-'));
  const remotes = join(root, 'remotes');
  mkdirSync(remotes, { recursive: true });

  // Seed commit, then one bare origin per project cloned from it.
  const seed = mkdtempSync(join(tmpdir(), 'dshwg-seed-'));
  run(['init', '--initial-branch=main'], seed);
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  run(['add', '.'], seed);
  run(['commit', '-m', 'chore: seed'], seed);

  const bares = {};
  const clone = (name) => {
    const bare = join(remotes, `${name.replace(/[\\/]/g, '-')}.git`);
    run(['clone', '--bare', seed, bare]);
    run(['clone', bare, name], root);
    bares[name] = bare;
    return join(root, name);
  };

  clone('app');
  const dirty = clone('app-dirty');
  writeFileSync(join(dirty, 'README.md'), '# seed\nchanged\n');
  writeFileSync(join(dirty, 'new-file.txt'), 'untracked\n');

  clone('app-behind');
  clone('app-ahead');
  mkdirSync(join(root, 'app-nested'), { recursive: true });
  clone('app-nested/deep');
  clone('node_modules/skipme');

  // Move every origin forward by one commit.
  writeFileSync(join(seed, 'SECOND.md'), 'second\n');
  run(['add', '.'], seed);
  run(['commit', '-m', 'feat: second'], seed);
  for (const bare of Object.values(bares)) run(['push', '--quiet', bare, 'HEAD:main'], seed);

  // app-behind only learns about the new commit through a fetch, never a pull.
  const behind = join(root, 'app-behind');
  run(['fetch', '--quiet'], behind);
  run(['pull', '--ff-only', '--quiet'], join(root, 'app'));
  run(['pull', '--ff-only', '--quiet'], dirty);
  run(['pull', '--ff-only', '--quiet'], join(root, 'app-nested', 'deep'));

  // app-ahead gets a commit that exists only locally.
  const ahead = join(root, 'app-ahead');
  run(['pull', '--ff-only', '--quiet'], ahead);
  writeFileSync(join(ahead, 'LOCAL.md'), 'local only\n');
  run(['add', '.'], ahead);
  run(['commit', '-m', 'feat: local only'], ahead);

  return {
    root,
    paths: {
      app: join(root, 'app'),
      dirty,
      behind,
      ahead,
      nested: join(root, 'app-nested', 'deep'),
      skipped: join(root, 'node_modules', 'skipme'),
    },
    bares,
    dispose() {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      rmSync(seed, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
