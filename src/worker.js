import { createSafeDocument, normalizeDesign } from './safe-document.js';
import { generateComposition, modelCatalog } from './models.js';
import { refundGenerationCredits, reserveGenerationCredits } from './credits.js';
import { grantTestCredits } from './payments.js';
import { exportObjectKey, renderHtmlToPng, stylePreviewObjectKey } from './export.js';
import { clearSessionCookie, createCode, createSession, hashSecret, normalizeEmail, sendCodeEmail, sessionCookie, sessionUserId, validEmail } from './auth.js';

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
  return payload && typeof payload.content === 'string' && payload.content.trim() && payload.content.length <= 10000;
}

function styleTemplatePayload(payload) {
  const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 80) : '';
  const description = typeof payload?.description === 'string' ? payload.description.trim().slice(0, 240) : '';
  const aspectRatio = ['auto', '1:1', '3:4', '9:16', '16:9'].includes(payload?.aspectRatio) ? payload.aspectRatio : 'auto';
  return { title, description, aspectRatio };
}

function autoAspectRatio(content) {
  if (content.length <= 220) return '1:1';
  if (content.length <= 500) return '3:4';
  return '9:16';
}

function viewportForAspectRatio(aspectRatio) {
  return ({ '1:1': { width: 1080, height: 1080 }, '3:4': { width: 1080, height: 1440 }, '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1600, height: 900 } })[aspectRatio];
}

async function createDocumentForOwner({ ownerId, payload, env }) {
  const documentId = id();
  const versionId = id();
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : '未命名作品';
  const objectKey = `documents/${documentId}/versions/${versionId}/safe.html`;
  const design = normalizeDesign(payload.design);
  const html = createSafeDocument({ title, content: payload.content, design });

  await env.ASSETS.put(objectKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').bind(ownerId),
    env.DB.prepare('INSERT INTO documents (id, owner_id, title, current_version_id) VALUES (?, ?, ?, ?)').bind(documentId, ownerId, title, versionId),
    env.DB.prepare('INSERT INTO document_versions (id, document_id, content_json, html_object_key, safety_status) VALUES (?, ?, ?, ?, ?)').bind(versionId, documentId, JSON.stringify({ content: payload.content, design }), objectKey, 'approved')
  ]);

  return { id: documentId, versionId, title, status: 'draft' };
}

async function createDocumentVersionForOwner({ ownerId, document, payload, env }) {
  const versionId = id();
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : document.title;
  const objectKey = `documents/${document.id}/versions/${versionId}/safe.html`;
  const design = normalizeDesign(payload.design);
  const html = createSafeDocument({ title, content: payload.content, design });

  await env.ASSETS.put(objectKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO document_versions (id, document_id, parent_version_id, content_json, html_object_key, safety_status) VALUES (?, ?, ?, ?, ?, ?)').bind(versionId, document.id, document.current_version_id, JSON.stringify({ content: payload.content, design }), objectKey, 'approved'),
    env.DB.prepare('UPDATE documents SET title = ?, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?').bind(title, versionId, document.id, ownerId)
  ]);

  return { id: document.id, versionId, title, status: document.status };
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
  const payload = await request.json().catch(() => ({}));

  const document = await env.DB.prepare('SELECT id, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });

  const versionId = typeof payload?.versionId === 'string' ? payload.versionId : document.current_version_id;
  const version = await env.DB.prepare('SELECT id, safety_status FROM document_versions WHERE id = ? AND document_id = ?').bind(versionId, document.id).first();
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

async function publishStyleTemplate(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => ({}));
  const document = await env.DB.prepare('SELECT id, title, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });
  const versionId = typeof payload?.versionId === 'string' ? payload.versionId : document.current_version_id;
  const version = await env.DB.prepare('SELECT id, content_json, html_object_key, safety_status FROM document_versions WHERE id = ? AND document_id = ?').bind(versionId, document.id).first();
  if (!version || version.safety_status !== 'approved') return json({ error: 'not_publishable' }, { status: 409 });
  const template = styleTemplatePayload(payload);
  if (!template.title) return badRequest('style title is required');
  const existing = await env.DB.prepare('SELECT id FROM style_templates WHERE source_document_id = ? AND source_version_id = ?').bind(document.id, version.id).first();
  if (existing) return json({ error: 'already_published' }, { status: 409 });
  const templateId = id();
  const source = JSON.parse(version.content_json);
  const aspectRatio = template.aspectRatio === 'auto' ? autoAspectRatio(source.content || '') : template.aspectRatio;
  const exportRecord = await env.DB.prepare('SELECT object_key FROM exports WHERE document_id = ? AND version_id = ? ORDER BY created_at DESC LIMIT 1').bind(document.id, version.id).first();
  let previewObjectKey = exportRecord?.object_key;
  if (!previewObjectKey) {
    const sourceObject = await env.ASSETS.get(version.html_object_key);
    if (!sourceObject) return json({ error: 'not_found' }, { status: 404 });
    try {
      previewObjectKey = stylePreviewObjectKey({ templateId });
      const png = await renderHtmlToPng(env.BROWSER, await sourceObject.text(), viewportForAspectRatio(aspectRatio));
      await env.ASSETS.put(previewObjectKey, png, { httpMetadata: { contentType: 'image/png' } });
    } catch (error) {
      return json({ error: error.message === 'render_failed' ? 'render_failed' : 'render_unavailable' }, { status: 503 });
    }
  }
  try {
    await env.DB.prepare('INSERT INTO style_templates (id, owner_id, source_document_id, source_version_id, title, description, style_key, aspect_ratio, preview_object_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(templateId, ownerId, document.id, version.id, template.title, template.description, 'document-reference', aspectRatio, previewObjectKey).run();
  } catch {
    return json({ error: 'already_published' }, { status: 409 });
  }
  return json({ id: templateId, ...template, aspectRatio, previewUrl: `/api/styles/${templateId}/preview`, likes: 0, uses: 0 }, { status: 201 });
}

async function listStyleTemplates(request, env) {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const viewerId = await sessionUserId(request, env);
  const filter = query ? 'WHERE t.title LIKE ? OR t.description LIKE ?' : '';
  const params = query ? [viewerId || '', `%${query}%`, `%${query}%`] : [viewerId || ''];
  const result = await env.DB.prepare(`SELECT t.id, t.title, t.description, t.style_key AS style, t.aspect_ratio AS aspectRatio, t.preview_object_key AS previewObjectKey, t.likes_count AS likes, t.uses_count AS uses, t.created_at, u.email AS author, EXISTS(SELECT 1 FROM style_template_likes l WHERE l.template_id = t.id AND l.user_id = ?) AS liked FROM style_templates t LEFT JOIN users u ON u.id = t.owner_id ${filter} ORDER BY t.uses_count DESC, t.likes_count DESC, t.created_at DESC LIMIT 50`).bind(...params).all();
  return json({ styles: (result.results || []).map(style => ({ ...style, previewUrl: style.previewObjectKey ? `/api/styles/${style.id}/preview` : null })) });
}

async function serveStylePreview(env, templateId) {
  const template = await env.DB.prepare('SELECT preview_object_key FROM style_templates WHERE id = ?').bind(templateId).first();
  if (!template?.preview_object_key) return new Response('Not found', { status: 404 });
  const object = await env.ASSETS.get(template.preview_object_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}

async function toggleStyleLike(request, env, templateId) {
  const userId = await sessionUserId(request, env);
  if (!userId) return json({ error: 'unauthorized' }, { status: 401 });
  const template = await env.DB.prepare('SELECT id FROM style_templates WHERE id = ?').bind(templateId).first();
  if (!template) return json({ error: 'not_found' }, { status: 404 });
  const existing = await env.DB.prepare('SELECT 1 FROM style_template_likes WHERE template_id = ? AND user_id = ?').bind(templateId, userId).first();
  if (existing) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM style_template_likes WHERE template_id = ? AND user_id = ?').bind(templateId, userId),
      env.DB.prepare('UPDATE style_templates SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').bind(templateId)
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO style_template_likes (template_id, user_id) VALUES (?, ?)').bind(templateId, userId),
      env.DB.prepare('UPDATE style_templates SET likes_count = likes_count + 1 WHERE id = ?').bind(templateId)
    ]);
  }
  const updated = await env.DB.prepare('SELECT likes_count AS likes FROM style_templates WHERE id = ?').bind(templateId).first();
  return json({ liked: !existing, likes: updated.likes });
}

async function useStyleTemplate(request, env, templateId) {
  const userId = await sessionUserId(request, env);
  if (!userId) return json({ error: 'unauthorized' }, { status: 401 });
  const template = await env.DB.prepare('SELECT t.id, t.title, t.description, t.uses_count AS uses, v.content_json FROM style_templates t JOIN document_versions v ON v.id = t.source_version_id WHERE t.id = ?').bind(templateId).first();
  if (!template) return json({ error: 'not_found' }, { status: 404 });
  const usage = await env.DB.prepare('INSERT OR IGNORE INTO style_template_uses (template_id, user_id) VALUES (?, ?)').bind(templateId, userId).run();
  if (usage.meta.changes) await env.DB.prepare('UPDATE style_templates SET uses_count = uses_count + 1 WHERE id = ?').bind(templateId).run();
  const updated = await env.DB.prepare('SELECT uses_count AS uses FROM style_templates WHERE id = ?').bind(templateId).first();
  const source = JSON.parse(template.content_json);
  return json({ style: { id: template.id, title: template.title, description: template.description, design: normalizeDesign(source.design), uses: updated.uses }, firstUse: Boolean(usage.meta.changes) });
}

async function createExport(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => ({}));

  const document = await env.DB.prepare('SELECT id, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });
  const versionId = typeof payload?.versionId === 'string' ? payload.versionId : document.current_version_id;
  const version = await env.DB.prepare('SELECT id, html_object_key FROM document_versions WHERE id = ? AND document_id = ? AND safety_status = ?').bind(versionId, document.id, 'approved').first();
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
  const existingDocument = typeof payload.documentId === 'string'
    ? await env.DB.prepare('SELECT id, title, status, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(payload.documentId, ownerId).first()
    : null;
  if (typeof payload.documentId === 'string' && !existingDocument) return json({ error: 'not_found' }, { status: 404 });
  const reference = typeof payload.styleTemplateId === 'string'
    ? await env.DB.prepare('SELECT v.content_json FROM style_templates t JOIN document_versions v ON v.id = t.source_version_id WHERE t.id = ?').bind(payload.styleTemplateId).first()
    : null;

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
        referenceDesign: reference ? normalizeDesign(JSON.parse(reference.content_json).design) : undefined,
        history: payload.history,
        revision: Boolean(existingDocument),
        env
      });
      const generatedContent = [...composition.paragraphs, composition.highlight].join('\n\n');
      const document = existingDocument
        ? await createDocumentVersionForOwner({ ownerId, document: existingDocument, payload: { title: composition.title, content: generatedContent, design: composition.design }, env })
        : await createDocumentForOwner({ ownerId, payload: { title: composition.title, content: generatedContent, design: composition.design }, env });
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
  if (!validEmail(email)) return badRequest('invalid email');
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
      return json({ models: Object.entries(modelCatalog).map(([id, model]) => ({ id, label: model.label, modelName: model.modelName, speed: model.speed, description: model.description, credits: model.credits })) });
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

    const publishStyleMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/styles$/);
    if (request.method === 'POST' && publishStyleMatch) return publishStyleTemplate(request, env, publishStyleMatch[1]);

    if (request.method === 'GET' && url.pathname === '/api/styles') return listStyleTemplates(request, env);

    const stylePreviewMatch = url.pathname.match(/^\/api\/styles\/([^/]+)\/preview$/);
    if (request.method === 'GET' && stylePreviewMatch) return serveStylePreview(env, stylePreviewMatch[1]);

    const likeStyleMatch = url.pathname.match(/^\/api\/styles\/([^/]+)\/like$/);
    if (request.method === 'POST' && likeStyleMatch) return toggleStyleLike(request, env, likeStyleMatch[1]);

    const useStyleMatch = url.pathname.match(/^\/api\/styles\/([^/]+)\/use$/);
    if (request.method === 'POST' && useStyleMatch) return useStyleTemplate(request, env, useStyleMatch[1]);

    const exportMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/exports$/);
    if (request.method === 'POST' && exportMatch) return createExport(request, env, exportMatch[1]);

    const downloadMatch = url.pathname.match(/^\/api\/exports\/([^/]+)$/);
    if (request.method === 'GET' && downloadMatch) return serveExport(request, env, downloadMatch[1]);

    const publicMatch = url.pathname.match(/^\/p\/([a-z0-9]+)$/);
    if (request.method === 'GET' && publicMatch) return servePublishedPage(env, publicMatch[1]);

    return json({ error: 'not_found' }, { status: 404 });
  }
};
