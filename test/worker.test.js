import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { createSafeDocument } from '../src/safe-document.js';
import { createCompositionPrompt, generateComposition, getModel, parseComposition } from '../src/models.js';
import { exportObjectKey, renderHtmlToPng } from '../src/export.js';
import { hashSecret, normalizeEmail, validEmail } from '../src/auth.js';
import { grantTestCredits } from '../src/payments.js';

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

test('public config exposes only the Turnstile site key', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/public-config'), { TURNSTILE_SITE_KEY: 'public-site-key', AUTH_PEPPER: 'must-not-leak' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { turnstileSiteKey: 'public-site-key' });
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

test('generation job requires a signed session before billing', async () => {
  const noIdentity = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', body: '{}' }), {});
  const noKey = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', headers: { 'x-user-id': 'u1' }, body: '{}' }), {});

  assert.equal(noIdentity.status, 401);
  assert.equal(noKey.status, 401);
});

test('model composition only accepts a bounded structured response', () => {
  const prompt = createCompositionPrompt({ title: '标题', content: '内容', instruction: '', style: 'note' });
  const composition = parseComposition('{"title":"标题","paragraphs":["第一段","第二段"],"highlight":"重点"}');

  assert.match(prompt, /Return JSON only/);
  assert.deepEqual(composition, { title: '标题', paragraphs: ['第一段', '第二段'], highlight: '重点' });
  assert.throws(() => parseComposition('{"title":"x"}'), /invalid_model_output/);
});

test('model adapter requests constrained JSON and never accepts HTML output directly', async () => {
  let request;
  const composition = await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '', style: 'note', env: { DEEPSEEK_API_KEY: 'key' },
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"标题","paragraphs":["正文"],"highlight":"重点"}' } }] }), { status: 200 });
    }
  });

  assert.match(request.url, /deepseek/);
  assert.deepEqual(JSON.parse(request.options.body).response_format, { type: 'json_object' });
  assert.deepEqual(composition, { title: '标题', paragraphs: ['正文'], highlight: '重点' });
});

test('export uses a fixed R2 key and stores Browser Run PNG output', async () => {
  const browser = { quickAction: async (action, request) => {
    assert.equal(action, 'screenshot');
    assert.equal(request.viewport.width, 1080);
    assert.match(request.html, /视觉作品/);
    return new Response('png-bytes', { status: 200 });
  } };

  assert.equal(exportObjectKey({ documentId: 'd1', versionId: 'v1', exportId: 'e1' }), 'documents/d1/versions/v1/exports/e1.png');
  assert.equal(await new Response(await renderHtmlToPng(browser, '<h1>视觉作品</h1>')).text(), 'png-bytes');
});

test('email identities normalize and OTP hashes do not expose the code', async () => {
  assert.equal(normalizeEmail('  Hello@Example.COM '), 'hello@example.com');
  assert.equal(validEmail('hello@example.com'), true);
  assert.equal(validEmail('not-an-email'), false);
  assert.notEqual(await hashSecret('123456', 'test-pepper'), '123456');
});

test('test payment credits the normal wallet ledger without calling Stripe', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { statements.push({ sql, values }); return { first: async () => ({ balance: 100 }) }; } };
    },
    batch: async () => undefined
  };

  const result = await grantTestCredits({ db, userId: 'u1' });

  assert.equal(result.credits, 100);
  assert.equal(result.balance, 100);
  assert.match(statements[0].sql, /UPDATE wallets SET balance = balance \+ \?/);
  assert.match(statements[1].sql, /'purchase'/);
});
