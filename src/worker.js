import { createSafeDocument, supportedStyles } from './safe-document.js';
import { generateComposition, modelCatalog } from './models.js';
import { refundGenerationCredits, reserveGenerationCredits } from './credits.js';
import { grantTestCredits } from './payments.js';
import { exportObjectKey, renderHtmlToPng } from './export.js';
import { clearSessionCookie, createCode, createSession, hashSecret, normalizeEmail, sendCodeEmail, sessionCookie, sessionUserId, validEmail, validateTurnstile } from './auth.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
});

const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
};

const id = () => crypto.randomUUID();
const slug = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

function badRequest(message) {
  return json({ error: 'bad_request', message }, { status: 400 });
}

function validDocumentPayload(payload) {
  return payload && typeof payload.content === 'string' && payload.content.trim() && payload.content.length <= 10000 && supportedStyles.includes(payload.style);
}

async function createDocumentForOwner({ ownerId, payload, env }) {
  const documentId = id();
  const versionId = id();
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : '未命名作品';
  const objectKey = `documents/${documentId}/versions/${versionId}/safe.html`;
  const html = createSafeDocument({ title, content: payload.content, style: payload.style });

  await env.ASSETS.put(objectKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').bind(ownerId),
    env.DB.prepare('INSERT INTO documents (id, owner_id, title, current_version_id) VALUES (?, ?, ?, ?)').bind(documentId, ownerId, title, versionId),
    env.DB.prepare('INSERT INTO document_versions (id, document_id, content_json, html_object_key, safety_status) VALUES (?, ?, ?, ?, ?)').bind(versionId, documentId, JSON.stringify({ content: payload.content, style: payload.style }), objectKey, 'approved')
  ]);

  return { id: documentId, versionId, title, status: 'draft' };
}

async function createDocument(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!validDocumentPayload(payload)) return badRequest('valid content and style are required');
  return json(await createDocumentForOwner({ ownerId, payload, env }), { status: 201 });
}

async function publishDocument(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });

  const document = await env.DB.prepare('SELECT id, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });

  const version = await env.DB.prepare('SELECT id, safety_status FROM document_versions WHERE id = ? AND document_id = ?').bind(document.current_version_id, document.id).first();
  if (!version || version.safety_status !== 'approved') return json({ error: 'not_publishable' }, { status: 409 });

  const publicSlug = slug();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO published_pages (slug, document_id, version_id) VALUES (?, ?, ?)').bind(publicSlug, document.id, version.id),
    env.DB.prepare("UPDATE documents SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(document.id)
  ]);

  const url = new URL(request.url);
  return json({ slug: publicSlug, url: `${url.origin}/p/${publicSlug}` }, { status: 201 });
}

async function servePublishedPage(env, publicSlug) {
  const page = await env.DB.prepare('SELECT version_id FROM published_pages WHERE slug = ?').bind(publicSlug).first();
  if (!page) return new Response('Not found', { status: 404 });

  const version = await env.DB.prepare('SELECT html_object_key FROM document_versions WHERE id = ? AND safety_status = ?').bind(page.version_id, 'approved').first();
  if (!version) return new Response('Not found', { status: 404 });

  const object = await env.ASSETS.get(version.html_object_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: htmlHeaders });
}

async function createExport(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });

  const version = await env.DB.prepare('SELECT v.id, v.html_object_key FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ? AND d.owner_id = ? AND v.safety_status = ?').bind(documentId, ownerId, 'approved').first();
  if (!version) return json({ error: 'not_found' }, { status: 404 });

  const htmlObject = await env.ASSETS.get(version.html_object_key);
  if (!htmlObject) return json({ error: 'not_found' }, { status: 404 });

  try {
    const exportId = id();
    const objectKey = exportObjectKey({ documentId, versionId: version.id, exportId });
    const png = await renderHtmlToPng(env.BROWSER, await htmlObject.text());
    await env.ASSETS.put(objectKey, png, { httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare('INSERT INTO exports (id, owner_id, document_id, version_id, object_key) VALUES (?, ?, ?, ?, ?)').bind(exportId, ownerId, documentId, version.id, objectKey).run();
    return json({ id: exportId, downloadUrl: `/api/exports/${exportId}` }, { status: 201 });
  } catch (error) {
    return json({ error: error.message === 'render_failed' ? 'render_failed' : 'render_unavailable' }, { status: 503 });
  }
}

async function serveExport(request, env, exportId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });

  const record = await env.DB.prepare('SELECT object_key FROM exports WHERE id = ? AND owner_id = ?').bind(exportId, ownerId).first();
  if (!record) return json({ error: 'not_found' }, { status: 404 });
  const object = await env.ASSETS.get(record.object_key);
  if (!object) return json({ error: 'not_found' }, { status: 404 });
  return new Response(object.body, { headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="zixian-${exportId}.png"` } });
}

async function createGenerationJob(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return badRequest('idempotency-key header is required');
  const payload = await request.json().catch(() => null);
  if (!validDocumentPayload(payload) || typeof payload.modelId !== 'string') return badRequest('valid content, style, and modelId are required');

  try {
    const reservation = await reserveGenerationCredits({
      db: env.DB,
      ownerId,
      documentId: typeof payload.documentId === 'string' ? payload.documentId : null,
      modelId: payload.modelId,
      idempotencyKey
    });

    if (reservation.state === 'insufficient_credits') return json({ error: 'insufficient_credits' }, { status: 402 });
    if (reservation.state === 'existing') return json(reservation, { status: 200 });

    await env.DB.prepare("UPDATE generation_jobs SET status = 'running' WHERE id = ? AND owner_id = ?").bind(reservation.job.id, ownerId).run();
    try {
      const composition = await generateComposition({
        modelId: payload.modelId,
        title: payload.title,
        content: payload.content,
        instruction: payload.instruction,
        style: payload.style,
        env
      });
      const generatedContent = [...composition.paragraphs, composition.highlight].join('\n\n');
      const document = await createDocumentForOwner({ ownerId, payload: { title: composition.title, content: generatedContent, style: payload.style }, env });
      await env.DB.prepare("UPDATE generation_jobs SET document_id = ?, status = 'succeeded', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(document.id, reservation.job.id, ownerId).run();
      return json({ job: { ...reservation.job, status: 'succeeded' }, document, composition }, { status: 201 });
    } catch (error) {
      await refundGenerationCredits({ db: env.DB, ownerId, jobId: reservation.job.id, credits: reservation.job.costCredits });
      return json({ error: error.message === 'invalid_model_output' ? 'model_output_invalid' : 'model_unavailable' }, { status: 503 });
    }
  } catch (error) {
    if (error.message === 'unsupported_model') return badRequest('unsupported model');
    throw error;
  }
}

async function wallet(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const record = await env.DB.prepare('SELECT balance FROM wallets WHERE user_id = ?').bind(ownerId).first();
  return json({ balance: record?.balance ?? 0 });
}

async function testPayment(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  if (env.PAYMENTS_MODE !== 'test') return json({ error: 'test_payments_disabled' }, { status: 403 });
  return json({ test: true, ...(await grantTestCredits({ db: env.DB, userId: ownerId })) }, { status: 201 });
}

async function requestLoginCode(request, env) {
  const payload = await request.json().catch(() => null);
  const email = normalizeEmail(payload?.email);
  if (!validEmail(email) || !await validateTurnstile(payload?.turnstileToken, request, env)) return json({ error: 'verification_required' }, { status: 400 });
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limits = await Promise.all([env.AUTH_RATE_LIMIT.limit({ key: `email:${email}` }), env.AUTH_RATE_LIMIT.limit({ key: `ip:${ip}` })]);
  if (limits.some(result => !result.success)) return json({ error: 'rate_limited' }, { status: 429 });
  const recent = await env.DB.prepare("SELECT id FROM email_codes WHERE email = ? AND created_at > datetime('now', '-60 seconds')").bind(email).first();
  if (recent) return json({ error: 'rate_limited' }, { status: 429 });
  const code = createCode();
  await sendCodeEmail({ email, code, env });
  await env.DB.prepare("INSERT INTO email_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))").bind(id(), email, await hashSecret(code, env.AUTH_PEPPER)).run();
  return json({ ok: true }, { status: 202 });
}

async function verifyLoginCode(request, env) {
  const payload = await request.json().catch(() => null);
  const email = normalizeEmail(payload?.email);
  const code = typeof payload?.code === 'string' ? payload.code : '';
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return badRequest('invalid email or code');
  const record = await env.DB.prepare("SELECT id, code_hash FROM email_codes WHERE email = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").bind(email).first();
  if (!record || record.code_hash !== await hashSecret(code, env.AUTH_PEPPER)) return json({ error: 'invalid_code' }, { status: 401 });
  await env.DB.prepare('UPDATE email_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?').bind(record.id).run();
  let user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    user = { id: id(), email };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(user.id, email),
      env.DB.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').bind(user.id, 0)
    ]);
  }
  const token = await createSession(user.id, env);
  return json({ user: { id: user.id, email } }, { headers: { 'set-cookie': sessionCookie(token) } });
}

async function logout(request, env) {
  const token = (request.headers.get('cookie') || '').match(/(?:^|;\s*)zixian_session=([^;]+)/)?.[1];
  if (token && env.AUTH_PEPPER) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashSecret(token, env.AUTH_PEPPER)).run();
  }
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'zixian-api', environment: env.APP_ORIGIN ? 'configured' : 'unconfigured' });
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      return json({ models: Object.entries(modelCatalog).map(([id, model]) => ({ id, label: model.label, credits: model.credits })) });
    }

    if (request.method === 'GET' && url.pathname === '/api/public-config') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/request-code') return requestLoginCode(request, env);
    if (request.method === 'POST' && url.pathname === '/api/auth/verify-code') return verifyLoginCode(request, env);
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') return logout(request, env);
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const currentUserId = await sessionUserId(request, env);
      if (!currentUserId) return json({ error: 'unauthorized' }, { status: 401 });
      const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(currentUserId).first();
      return json({ user });
    }

    if (request.method === 'GET' && url.pathname === '/api/wallet') return wallet(request, env);
    if (request.method === 'POST' && url.pathname === '/api/test-payments') return testPayment(request, env);

    if (request.method === 'POST' && url.pathname === '/api/generation-jobs') return createGenerationJob(request, env);

    if (request.method === 'POST' && url.pathname === '/api/documents') return createDocument(request, env);

    const publishMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/publish$/);
    if (request.method === 'POST' && publishMatch) return publishDocument(request, env, publishMatch[1]);

    const exportMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/exports$/);
    if (request.method === 'POST' && exportMatch) return createExport(request, env, exportMatch[1]);

    const downloadMatch = url.pathname.match(/^\/api\/exports\/([^/]+)$/);
    if (request.method === 'GET' && downloadMatch) return serveExport(request, env, downloadMatch[1]);

    const publicMatch = url.pathname.match(/^\/p\/([a-z0-9]+)$/);
    if (request.method === 'GET' && publicMatch) return servePublishedPage(env, publicMatch[1]);

    return json({ error: 'not_found' }, { status: 404 });
  }
};
