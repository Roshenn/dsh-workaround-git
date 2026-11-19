/**
 * Draft reasoning effort: a commit message is a short, format-constrained
 * output, so the AI draft runs at `off` even when the session model sits at
 * `max`. The effort is capability-checked first, because dsh rejects an
 * explicit unsupported effort before provider I/O instead of clamping it: a
 * model without `off` keeps the inherited effort rather than failing.
 *
 * Every case runs against a throwaway repo with one uncommitted change; the
 * model is a fake `llm` service, so no provider is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestMessage } from '../lib/suggest.mjs';
import { run } from './fixtures.mjs';

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A repo with one uncommitted change, which is what a draft describes. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dshwg-suggest-'));
  cleanups.push(dir);
  run(['init', '-q'], dir);
  writeFileSync(join(dir, 'note.txt'), 'one\n');
  run(['add', '.'], dir);
  run(['commit', '-q', '-m', 'chore: seed'], dir);
  writeFileSync(join(dir, 'note.txt'), 'one\ntwo\n');
  return dir;
}

/**
 * A ctx whose llm records the options it was called with. `model` is unique per
 * case so the module-level capability cache does not leak between tests.
 */
function fakeCtx({ model, selection = { provider: 'fake', model, reasoningEffort: 'max' }, efforts, metadata = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    get(name) {
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            if (metadata === 'throw') throw new Error('capabilities unavailable');
            if (metadata === 'missing') return {};
            return { reasoning: { efforts: (efforts ?? []).map((id) => ({ id })) } };
          },
          stream: async function* stream(options) {
            calls.push(options);
            yield { type: 'text-delta', text: 'fix: change note' };
            yield { type: 'finish', reason: 'stop' };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => selection };
      return undefined;
    },
  };
}

test('drafts run at off even when the session default is max', async () => {
  const ctx = fakeCtx({ model: 'off-model', efforts: ['off', 'low', 'high', 'max'] });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].reasoningEffort, 'off');
});

test('a model that does not advertise off keeps the inherited effort', async () => {
  const ctx = fakeCtx({ model: 'no-off-model', efforts: ['low', 'high', 'max'] });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].reasoningEffort, 'max');
});

test('missing reasoning metadata keeps the inherited effort', async () => {
  const ctx = fakeCtx({ model: 'no-metadata-model', metadata: 'missing' });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].reasoningEffort, 'max');
});

test('an unreachable capability probe keeps the inherited effort and still drafts', async () => {
  const ctx = fakeCtx({ model: 'unreachable-model', metadata: 'throw' });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].reasoningEffort, 'max');
});

test('a selection without an effort still drafts at off', async () => {
  const ctx = fakeCtx({
    model: 'fallback-model',
    selection: { provider: 'fake', model: 'fallback-model' },
    efforts: ['off'],
  });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].reasoningEffort, 'off');
});
