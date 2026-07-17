import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { createSafeDocument } from '../src/safe-document.js';
import { createCompositionPrompt, getModel, parseComposition } from '../src/models.js';

test('health endpoint identifies the worker', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health'), { APP_ORIGIN: 'http://localhost:4173' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'zijian-api', environment: 'configured' });
});

test('unknown endpoint returns a JSON 404', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/missing'), {});

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('safe document escapes user-provided markup and has no script execution', () => {
  const html = createSafeDocument({
    title: '<img src=x onerror=alert(1)>',
    content: '第一段\n\n<script>alert(1)</script>',
    style: 'note'
  });

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('model catalog exposes fixed credit costs', () => {
  assert.equal(getModel('fast').credits, 6);
  assert.equal(getModel('missing'), null);
});

test('generation job requires identity and an idempotency key before billing', async () => {
  const noIdentity = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', body: '{}' }), {});
  const noKey = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', headers: { 'x-user-id': 'u1' }, body: '{}' }), {});

  assert.equal(noIdentity.status, 401);
  assert.equal(noKey.status, 400);
});

test('model composition only accepts a bounded structured response', () => {
  const prompt = createCompositionPrompt({ title: '标题', content: '内容', instruction: '', style: 'note' });
  const composition = parseComposition('{"title":"标题","paragraphs":["第一段","第二段"],"highlight":"重点"}');

  assert.match(prompt, /Return JSON only/);
  assert.deepEqual(composition, { title: '标题', paragraphs: ['第一段', '第二段'], highlight: '重点' });
  assert.throws(() => parseComposition('{"title":"x"}'), /invalid_model_output/);
});
