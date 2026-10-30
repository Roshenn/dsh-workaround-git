/**
 * Human-facing demo: build a throwaway multi-repo workspace, then print the
 * exact tool output a model would see. No DSH runtime required.
 *
 *   node scripts/smoke.mjs
 */
import { makeWorkspace } from '../test/fixtures.mjs';
import { changesAll, statusAll, syncAll } from '../lib/git.mjs';
import { formatChanges, formatStatus, formatSync } from '../lib/format.mjs';

const ws = makeWorkspace();
try {
  console.log('— git_workspace_status —\n');
  console.log(formatStatus(await statusAll(ws.root)));

  console.log('\n— git_workspace_sync (dry run) —\n');
  console.log(formatSync(await syncAll(ws.root, { dryRun: true })));

  console.log('\n— git_workspace_changes —\n');
  console.log(formatChanges(await changesAll(ws.root)));
} finally {
  ws.dispose();
}
