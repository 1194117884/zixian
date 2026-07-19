import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { createSafeDocument } from '../src/safe-document.js';
import { createCompositionPrompt, generateComposition, getModel, parseComposition } from '../src/models.js';
import { exportObjectKey, renderHtmlToPng, stylePreviewObjectKey } from '../src/export.js';
import { hashSecret, normalizeEmail, validEmail } from '../src/auth.js';
import { grantTestCredits } from '../src/payments.js';
import { CLOUD_RENDER_CREDITS, refundCloudRenderCredits, refundGenerationCredits, reserveCloudRenderCredits } from '../src/credits.js';

test('health endpoint identifies the worker', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health'), { APP_ORIGIN: 'http://localhost:4173' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'zixian-api', environment: 'configured' });
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
    design: { background: '#113355', foreground: '#ffffff', accent: '#ffcc00', label: 'MY DESIGN' }
  });

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /min-height:100vh/);
  assert.match(createSafeDocument({ title: '标题', content: '正文', design: { background: '#113355', foreground: '#ffffff', accent: '#ffcc00', label: 'MY DESIGN' } }), /#113355/);
});

test('model catalog exposes fixed credit costs', () => {
  assert.equal(getModel('fast').credits, 6);
  assert.equal(getModel('fast').speed, '最快');
  assert.equal(getModel('missing'), null);
});

test('model API exposes capability, speed, and credit cost', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/models'), {});
  const { models } = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(models[0], { id: 'fast', label: '快速创作', modelName: 'DeepSeek Flash', speed: '最快', description: '快速整理想法与短文，适合日常灵感。', credits: 6 });
});

test('generation job requires a signed session before billing', async () => {
  const noIdentity = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', body: '{}' }), {});
  const noKey = await worker.fetch(new Request('https://example.test/api/generation-jobs', { method: 'POST', headers: { 'x-user-id': 'u1' }, body: '{}' }), {});

  assert.equal(noIdentity.status, 401);
  assert.equal(noKey.status, 401);
});

test('private document preview requires a signed session', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/documents/d1/versions/v1/preview'), {});

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('admin endpoints require a signed administrator session', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/admin/overview'), {});

  assert.equal(response.status, 401);
});

test('model composition only accepts a bounded structured response', () => {
  const prompt = createCompositionPrompt({ title: '标题', content: '内容', instruction: '' });
  const composition = parseComposition('{"title":"标题","paragraphs":["第一段","第二段"],"highlight":"重点"}');

  assert.match(prompt, /first draft/);
  assert.deepEqual(composition, { title: '标题', paragraphs: ['第一段', '第二段'], highlight: '重点', design: {} });
  assert.throws(() => parseComposition('{"title":"x"}'), /invalid_model_output/);
});

test('model adapter requests constrained JSON and never accepts HTML output directly', async () => {
  let request;
  const composition = await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '改成炫彩赛博朋克', history: [{ role: 'user', content: '先做第一版' }], revision: true, env: { DEEPSEEK_API_KEY: 'key' }, systemPromptOverride: '后台提示词', providerOverrides: { deepseek: { apiKey: 'admin-key', baseUrl: 'https://gateway.example/v1/chat/completions' } },
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"标题","paragraphs":["正文"],"highlight":"重点","design":{"background":"#113355","foreground":"#ffffff","accent":"#ffcc00","label":"MY DESIGN"}}' } }] }), { status: 200 });
    }
  });

  assert.equal(request.url, 'https://gateway.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer admin-key');
  assert.deepEqual(JSON.parse(request.options.body).response_format, { type: 'json_object' });
  assert.equal(JSON.parse(request.options.body).messages[0].content, '后台提示词');
  assert.equal(JSON.parse(request.options.body).messages[1].content, '先做第一版');
  assert.deepEqual(composition, { title: '标题', paragraphs: ['正文'], highlight: '重点', design: { background: '#113355', foreground: '#ffffff', accent: '#ffcc00', label: 'MY DESIGN' } });
});

test('model adapter spreads requests across accounts and fails over after a rate limit', async () => {
  const attempts = [];
  const composition = await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '', requestKey: 'b', env: {},
    providerOverrides: { accounts: [{ platform: 'DeepSeek', tier: 'fast', modelName: 'deepseek-chat', apiKey: 'first', baseUrl: 'https://one.example/chat' }, { platform: 'DeepSeek', tier: 'fast', modelName: 'deepseek-chat', apiKey: 'second', baseUrl: 'https://two.example/chat' }] },
    fetcher: async (url, options) => {
      attempts.push({ url, key: options.headers.authorization });
      if (attempts.length === 1) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"标题","paragraphs":["正文"],"highlight":"重点"}' } }] }), { status: 200 });
    }
  });

  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].key, attempts[1].key);
  assert.equal(composition.title, '标题');
});

test('export uses a fixed R2 key and stores Browser Run PNG output', async () => {
  const browser = { quickAction: async (action, request) => {
    assert.equal(action, 'screenshot');
    assert.equal(request.viewport.width, 1080);
    assert.equal(request.selector, 'body');
    assert.match(request.html, /视觉作品/);
    return new Response('png-bytes', { status: 200 });
  } };

  assert.equal(exportObjectKey({ documentId: 'd1', versionId: 'v1', exportId: 'e1' }), 'documents/d1/versions/v1/exports/e1.png');
  assert.equal(stylePreviewObjectKey({ templateId: 's1' }), 'style-templates/s1/preview.png');
  const png = await renderHtmlToPng(browser, '<h1>视觉作品</h1>');
  assert.equal(png.byteLength, 9);
  assert.equal(await new Response(png).text(), 'png-bytes');
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

test('failed generation refunds only through the existing credit ledger', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { statements.push({ sql, values }); return {}; } };
    },
    batch: async () => undefined
  };

  await refundGenerationCredits({ db, ownerId: 'u1', jobId: 'j1', credits: 6 });

  assert.match(statements[0].sql, /status = 'refunded'/);
  assert.match(statements[1].sql, /'refund'/);
  assert.match(statements[2].sql, /balance = balance \+ \?/);
});

test('cloud render reserves one credit in the server ledger', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { statements.push({ sql, values }); return { first: async () => null }; } };
    },
    batch: async () => [{ meta: { changes: 1 } }]
  };

  const result = await reserveCloudRenderCredits({ db, ownerId: 'u1', documentId: 'd1', versionId: 'v1', idempotencyKey: 'render-1' });

  assert.equal(CLOUD_RENDER_CREDITS, 1);
  assert.equal(result.state, 'reserved');
  assert.ok(statements.some(statement => /'cloud_render'/.test(statement.sql)));
  assert.ok(statements.some(statement => /INSERT INTO render_jobs/.test(statement.sql)));
});

test('failed cloud render refunds through the server ledger', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { statements.push({ sql, values }); return {}; } };
    },
    batch: async () => undefined
  };

  await refundCloudRenderCredits({ db, ownerId: 'u1', jobId: 'r1' });

  assert.match(statements[0].sql, /render_jobs SET status = 'refunded'/);
  assert.match(statements[1].sql, /'refund'/);
  assert.match(statements[2].sql, /balance = balance \+ \?/);
});
