/**
 * Draft reasoning effort: a commit message is a short, format-constrained
 * output, so the AI draft runs at `low` even when the session model sits at
 * `max`. The effort is capability-checked first, because dsh rejects an
 * explicit unsupported effort before provider I/O instead of clamping it, and
 * a provider can still reject an advertised effort at its endpoint (the
 * enrigin route does that for `off`). In that case the draft retries once at
 * the inherited effort instead of failing.
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
 * case so the module-level effort cache does not leak between tests.
 * `outcomes` drives successive calls: 'text' streams a message, 'error' ends
 * with an error finish carrying no text.
 */
function fakeCtx({ model, selection = { provider: 'fake', model, reasoningEffort: 'max' }, efforts, metadata = 'ok', outcomes = ['text'] } = {}) {
  const calls = [];
  let call = 0;
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
            const outcome = outcomes[Math.min(call, outcomes.length - 1)];
            call += 1;
            if (outcome === 'error') {
              yield {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: { code: 'INVALID_REQUEST', message: 'reasoning effort not supported', status: 400 },
                },
              };
              return;
            }
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

test('drafts run at low even when the session default is max', async () => {
  const ctx = fakeCtx({ model: 'low-model', efforts: ['low', 'high', 'max'] });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].reasoningEffort, 'low');
});

test('a model that does not advertise low keeps the inherited effort', async () => {
  const ctx = fakeCtx({ model: 'no-low-model', efforts: ['high', 'max'] });
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

test('a selection without an effort still drafts at low', async () => {
  const ctx = fakeCtx({
    model: 'fallback-model',
    selection: { provider: 'fake', model: 'fallback-model' },
    efforts: ['low'],
  });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, true);
  assert.equal(ctx.calls[0].reasoningEffort, 'low');
});

test('a rejected cheap effort retries once at the inherited effort, then remembers it', async () => {
  const ctx = fakeCtx({ model: 'retry-model', efforts: ['low', 'high', 'max'], outcomes: ['error', 'text'] });
  const repo = makeRepo();
  const first = await suggestMessage(ctx, repo, {});
  assert.equal(first.ok, true);
  assert.deepEqual(ctx.calls.map((call) => call.reasoningEffort), ['low', 'max']);

  // The winning effort is cached: the next draft skips the rejected one.
  const second = await suggestMessage(ctx, repo, {});
  assert.equal(second.ok, true);
  assert.deepEqual(ctx.calls.map((call) => call.reasoningEffort), ['low', 'max', 'max']);
});

test('a draft that fails at every effort names the provider failure', async () => {
  const ctx = fakeCtx({ model: 'both-fail-model', efforts: ['low', 'max'], outcomes: ['error'] });
  const result = await suggestMessage(ctx, makeRepo(), {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'llm-output');
  assert.match(result.error.message, /INVALID_REQUEST/);
  assert.match(result.error.message, /reasoning effort not supported/);
  assert.doesNotMatch(result.error.message, /\[object Object\]/);
});
