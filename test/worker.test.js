import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { createSafeDocument, sanitizeHtmlDocument, sanitizeHtmlFragment } from '../src/safe-document.js';
import { createCompositionPrompt, generateComposition, getModel, parseComposition, systemPrompt } from '../src/models.js';
import { exportObjectKey, renderHtmlToPng, stylePreviewObjectKey } from '../src/export.js';
import { hashSecret, normalizeEmail, validEmail } from '../src/auth.js';
import { grantTestCredits } from '../src/payments.js';
import { CLOUD_RENDER_CREDITS, refundCloudRenderCredits, refundGenerationCredits, reserveCloudRenderCredits } from '../src/credits.js';

test('health endpoint identifies the worker', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health'), { APP_ORIGIN: 'http://localhost:4173' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'zixian-api', environment: 'configured' });
});

test('sitemap includes the homepage and published works', async () => {
  const response = await worker.fetch(new Request('https://example.test/sitemap.xml'), {
    APP_ORIGIN: 'https://zixian.yongkl.cc',
    DB: { prepare() { return { all: async () => ({ results: [{ slug: 'public-work', createdAt: '2026-07-19 12:00:00' }] }) }; } }
  });
  const body = await response.text();

  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(body, /<loc>https:\/\/zixian\.yongkl\.cc\/<\/loc>/);
  assert.match(body, /<loc>https:\/\/zixian\.yongkl\.cc\/p\/public-work<\/loc>/);
  assert.match(body, /<lastmod>2026-07-19<\/lastmod>/);
});

test('published work receives canonical and social metadata', async () => {
  let query = 0;
  const response = await worker.fetch(new Request('https://zixian.yongkl.cc/p/publicwork'), {
    APP_ORIGIN: 'https://zixian.yongkl.cc',
    DB: {
      prepare() {
        query += 1;
        return { bind() { return { first: async () => query === 1 ? { version_id: 'v1' } : { objectKey: 'documents/d1/versions/v1/safe.html', contentJson: JSON.stringify({ sourceContent: '一段公开文案。' }), title: '公开作品标题' } }; } };
      }
    },
    ASSETS: { get: async () => ({ text: async () => '<!doctype html><html><head><title>公开作品标题</title></head><body>内容</body></html>' }) }
  });
  const body = await response.text();

  assert.match(body, /rel="canonical" href="https:\/\/zixian\.yongkl\.cc\/p\/publicwork"/);
  assert.match(body, /property="og:title" content="公开作品标题"/);
  assert.match(body, /name="description" content="一段公开文案。"/);
});

test('unknown endpoint returns a JSON 404', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/missing'), {});

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('missing D1 schema returns a retryable service response', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/styles'), {
    DB: { prepare() { throw new Error('no such table: style_templates'); } }
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'database_not_ready', retryable: true, retryAfter: 30 });
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

test('AI HTML fragments retain only allowed tags and Tailwind utility classes', () => {
  const fragment = sanitizeHtmlFragment('<div class="p-8 bg-stone-50 evil" onclick="alert(1)"><h1 class="text-4xl font-serif">标题</h1><script>alert(1)</script><img src=x><p style="color:red">正文</p></div>');
  const html = createSafeDocument({ title: '标题', fragment });

  assert.match(fragment, /class="p-8 bg-stone-50"/);
  assert.doesNotMatch(fragment, /onclick|script|img|style=/);
  assert.match(html, /\.p-8\{padding:2rem/);
});

test('full AI documents preserve inline CSS while removing active content and network URLs', () => {
  const safe = sanitizeHtmlDocument('<!doctype html><html><head><style>@import url(https://evil.example/a.css); .poster{background:#16223a url(https://evil.example/a.png);color:#fff}</style></head><body><main class="poster" onclick="alert(1)"><h1>标题</h1><script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="https://evil.example">跳转</a></main></body></html>');
  const html = createSafeDocument({ title: '标题', htmlDocument: '<style>.poster{color:#fff;background:#16223a}</style><main class="poster"><h1>标题</h1></main>' });

  assert.match(safe.css, /background:#16223a/);
  assert.doesNotMatch(safe.css, /@import|url\(/);
  assert.match(safe.body, /<main class="poster">/);
  assert.doesNotMatch(safe.body, /onclick|script|iframe|href=/);
  assert.match(html, /\.poster\{color:#fff;background:#16223a\}/);
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

test('model composition accepts a complete static HTML document', () => {
  const prompt = createCompositionPrompt({ title: '标题', content: '内容', instruction: '' });
  const composition = parseComposition('<!doctype html><html><head><title>标题</title><style>body{background:#111}</style></head><body><main><p>第一段</p></main></body></html>');

  assert.match(prompt, /first draft/);
  assert.equal(composition.title, '标题');
  assert.match(composition.html, /<style>/);
  assert.throws(() => parseComposition('just text'), /invalid_model_output/);
  assert.match(systemPrompt, /complete static HTML document/);
});

test('model adapter requests complete static HTML without JSON mode', async () => {
  let request;
  const generated = await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '改成炫彩赛博朋克', history: [{ role: 'user', content: '先做第一版' }], revision: true, env: { DEEPSEEK_API_KEY: 'key' }, systemPromptOverride: '后台提示词', providerOverrides: { deepseek: { apiKey: 'admin-key', baseUrl: 'https://gateway.example/v1/chat/completions' } },
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '<!doctype html><html><head><title>标题</title><style>body{background:#123}</style></head><body><main><h1>标题</h1><p>正文</p></main></body></html>' } }] }), { status: 200 });
    }
  });

  assert.equal(request.url, 'https://gateway.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer admin-key');
  assert.equal(JSON.parse(request.options.body).response_format, undefined);
  assert.equal(JSON.parse(request.options.body).messages[0].content, '后台提示词');
  assert.equal(JSON.parse(request.options.body).messages[1].content, '先做第一版');
  assert.equal(generated.composition.title, '标题');
  assert.match(generated.composition.html, /body\{background:#123\}/);
});

test('model adapter spreads requests across accounts and fails over after a rate limit', async () => {
  const attempts = [];
  const generated = await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '', requestKey: 'b', env: {},
    providerOverrides: { accounts: [{ platform: '任意平台', apiFormat: 'openai', tier: 'fast', modelName: 'deepseek-chat', apiKey: 'first', baseUrl: 'https://one.example/chat' }, { platform: '任意平台', apiFormat: 'openai', tier: 'fast', modelName: 'deepseek-chat', apiKey: 'second', baseUrl: 'https://two.example/chat' }] },
    fetcher: async (url, options) => {
      attempts.push({ url, key: options.headers.authorization, modelName: JSON.parse(options.body).model });
      if (attempts.length === 1) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<!doctype html><html><head><title>标题</title></head><body><main><p>正文</p></main></body></html>' } }], usage: { prompt_tokens: 21, completion_tokens: 34 } }), { status: 200 });
    }
  });

  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].key, attempts[1].key);
  assert.equal(attempts[1].modelName, 'deepseek-chat');
  assert.equal(generated.composition.title, '标题');
  assert.equal(generated.telemetry.attempts.length, 2);
  assert.equal(generated.telemetry.selected.modelName, 'deepseek-chat');
  assert.equal(generated.telemetry.selected.outputTokens, 34);
});

test('model adapter excludes paused channels from routing', async () => {
  let url = '';
  await generateComposition({
    modelId: 'fast', title: '标题', content: '内容', instruction: '', env: {},
    providerOverrides: { accounts: [{ tier: 'fast', enabled: false, apiKey: 'paused', baseUrl: 'https://paused.example/chat' }, { tier: 'fast', enabled: true, apiKey: 'active', baseUrl: 'https://active.example/chat' }] },
    fetcher: async requestUrl => {
      url = requestUrl;
      return new Response(JSON.stringify({ choices: [{ message: { content: '<!doctype html><html><body><p>正文</p></body></html>' } }] }), { status: 200 });
    }
  });
  assert.equal(url, 'https://active.example/chat');
});

test('model adapter exposes invalid structured output separately from an unavailable model', async () => {
  await assert.rejects(
    generateComposition({ modelId: 'fast', title: '标题', content: '内容', instruction: '', env: {}, providerOverrides: { accounts: [{ tier: 'fast', apiKey: 'key', baseUrl: 'https://example.test/chat' }] }, fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"标题"}' } }] }), { status: 200 }) }),
    /invalid_model_output/
  );
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
  assert.match(statements[2].sql, /INSERT INTO payment_orders/);
});

test('failed generation refunds only through the existing credit ledger', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { statements.push({ sql, values }); return {}; } };
    },
    batch: async () => undefined
  };

  const refund = await refundGenerationCredits({ db, ownerId: 'u1', jobId: 'j1', credits: 6, errorCode: 'model_output_invalid' });

  assert.deepEqual(refund, { status: 'refunded', credits: 6 });
  assert.match(statements[0].sql, /status = 'refunded'/);
  assert.deepEqual(statements[0].values, ['model_output_invalid', 'j1', 'u1']);
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
