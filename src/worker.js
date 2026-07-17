import { createSafeDocument, supportedStyles } from './safe-document.js';

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

const userId = request => request.headers.get('x-user-id');
const id = () => crypto.randomUUID();
const slug = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

function badRequest(message) {
  return json({ error: 'bad_request', message }, { status: 400 });
}

async function createDocument(request, env) {
  const ownerId = userId(request);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload.content !== 'string' || !payload.content.trim()) return badRequest('content is required');
  if (payload.content.length > 10000) return badRequest('content exceeds 10,000 characters');
  if (!supportedStyles.includes(payload.style)) return badRequest('unsupported style');

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

  return json({ id: documentId, versionId, title, status: 'draft' }, { status: 201 });
}

async function publishDocument(request, env, documentId) {
  const ownerId = userId(request);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'zijian-api', environment: env.APP_ORIGIN ? 'configured' : 'unconfigured' });
    }

    if (request.method === 'POST' && url.pathname === '/api/documents') return createDocument(request, env);

    const publishMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/publish$/);
    if (request.method === 'POST' && publishMatch) return publishDocument(request, env, publishMatch[1]);

    const publicMatch = url.pathname.match(/^\/p\/([a-z0-9]+)$/);
    if (request.method === 'GET' && publicMatch) return servePublishedPage(env, publicMatch[1]);

    return json({ error: 'not_found' }, { status: 404 });
  }
};
