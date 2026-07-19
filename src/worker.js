import { createSafeDocument, normalizeDesign } from './safe-document.js';
import { generateComposition, modelCatalog, systemPrompt } from './models.js';
import { refundCloudRenderCredits, refundGenerationCredits, reserveCloudRenderCredits, reserveGenerationCredits } from './credits.js';
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

const privateHtmlHeaders = {
  ...htmlHeaders,
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
};

const id = () => crypto.randomUUID();
const slug = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

function badRequest(message) {
  return json({ error: 'bad_request', message }, { status: 400 });
}

async function adminUser(request, env) {
  const userId = await sessionUserId(request, env);
  if (!userId) return { error: 'unauthorized' };
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();
  const allowedEmails = new Set((env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean));
  if (!user?.email || !allowedEmails.has(normalizeEmail(user.email))) return { error: 'forbidden' };
  return { user };
}

async function adminMe(request, env) {
  const identity = await adminUser(request, env);
  if (identity.error) return json({ error: identity.error }, { status: identity.error === 'unauthorized' ? 401 : 403 });
  return json({ user: identity.user });
}

async function adminOverview(request, env) {
  const identity = await adminUser(request, env);
  if (identity.error) return json({ error: identity.error }, { status: identity.error === 'unauthorized' ? 401 : 403 });
  const [users, documents, generations, credits, usersToday, documentsToday, recent, channelRuns, activeCreators, tokenTotals, testOrders, liveRevenue, channelSummary] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS count FROM users'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM documents'),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generation_jobs WHERE status = 'succeeded'"),
    env.DB.prepare("SELECT COALESCE(-SUM(amount), 0) AS count FROM credit_ledger WHERE reason IN ('generation', 'cloud_render')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE created_at >= datetime('now', '-1 day')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE created_at >= datetime('now', '-1 day')"),
    env.DB.prepare("SELECT u.email, g.model_id AS modelId, g.cost_credits AS costCredits, g.created_at AS createdAt, g.provider_platform AS providerPlatform, g.provider_model_name AS providerModelName, g.input_tokens AS inputTokens, g.output_tokens AS outputTokens, g.attempt_count AS attemptCount FROM generation_jobs g LEFT JOIN users u ON u.id = g.owner_id WHERE g.status = 'succeeded' ORDER BY g.created_at DESC LIMIT 12"),
    env.DB.prepare("SELECT a.provider_platform AS providerPlatform, a.provider_model_name AS providerModelName, a.http_status AS httpStatus, a.error_code AS errorCode, a.created_at AS createdAt, g.model_id AS modelId FROM generation_attempts a JOIN generation_jobs g ON g.id = a.generation_job_id ORDER BY a.created_at DESC LIMIT 16"),
    env.DB.prepare("SELECT COUNT(DISTINCT owner_id) AS count FROM generation_jobs WHERE status = 'succeeded' AND created_at >= datetime('now', '-30 days')"),
    env.DB.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens FROM generation_jobs WHERE status = 'succeeded' AND created_at >= datetime('now', '-30 days')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE payment_mode = 'test' AND status = 'succeeded'"),
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS amountCents FROM payment_orders WHERE payment_mode = 'live' AND status = 'succeeded'"),
    env.DB.prepare("SELECT provider_platform AS providerPlatform, provider_model_name AS providerModelName, COUNT(*) AS requests, SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successes, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens FROM generation_attempts WHERE created_at >= datetime('now', '-30 days') GROUP BY provider_platform, provider_model_name ORDER BY requests DESC LIMIT 12")
  ]);
  return json({
    totals: { users: users.results[0].count, documents: documents.results[0].count, generations: generations.results[0].count, creditsUsed: credits.results[0].count },
    today: { users: usersToday.results[0].count, documents: documentsToday.results[0].count },
    thirtyDays: { activeCreators: activeCreators.results[0].count, inputTokens: tokenTotals.results[0].inputTokens, outputTokens: tokenTotals.results[0].outputTokens },
    orders: { testCount: testOrders.results[0].count, liveRevenueCents: liveRevenue.results[0].amountCents },
    recentGenerations: (recent.results || []).map(item => ({ ...item, modelLabel: modelCatalog[item.modelId]?.label || item.modelId })),
    recentChannelRuns: (channelRuns.results || []).map(item => ({ ...item, modelLabel: modelCatalog[item.modelId]?.label || item.modelId })),
    channelSummary: channelSummary.results || []
  });
}

async function recordGenerationTelemetry(env, jobId, telemetry) {
  const attempts = telemetry.attempts.slice(0, 36);
  const selected = telemetry.selected;
  await env.DB.batch([
    env.DB.prepare('UPDATE generation_jobs SET provider_platform = ?, provider_model_name = ?, provider_account_id = ?, input_tokens = ?, output_tokens = ?, attempt_count = ? WHERE id = ?').bind(selected.platform, selected.modelName, selected.accountId, selected.inputTokens, selected.outputTokens, attempts.length, jobId),
    ...attempts.map((attempt, index) => env.DB.prepare('INSERT INTO generation_attempts (id, generation_job_id, attempt_index, provider_platform, provider_model_name, provider_account_id, http_status, error_code, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id(), jobId, index + 1, attempt.platform, attempt.modelName, attempt.accountId, attempt.httpStatus, attempt.errorCode, attempt.inputTokens, attempt.outputTokens))
  ]);
}

const aiConfigKey = 'ai_config';
const legacyProviders = {
  deepseek: { platform: 'DeepSeek', apiFormat: 'openai', tier: 'fast', modelName: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1/chat/completions', envKey: 'DEEPSEEK_API_KEY' },
  openai: { platform: 'OpenAI', apiFormat: 'openai', tier: 'precise', modelName: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1/chat/completions', envKey: 'OPENAI_API_KEY' },
  anthropic: { platform: 'Anthropic', apiFormat: 'anthropic', tier: 'studio', modelName: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com/v1/messages', envKey: 'ANTHROPIC_API_KEY' }
};
const validTiers = new Set(Object.keys(modelCatalog));
const encodeBase64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const decodeBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function configCryptoKey(secret) {
  if (!secret) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptConfigValue(value, secret) {
  const key = await configCryptoKey(secret);
  if (!key) throw new Error('config_secret_unavailable');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${encodeBase64(iv)}.${encodeBase64(encrypted)}`;
}

async function decryptConfigValue(value, secret) {
  if (!value || !secret) return '';
  try {
    const [encodedIv, encodedValue] = value.split('.');
    const key = await configCryptoKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(encodedIv) }, key, decodeBase64(encodedValue));
    return new TextDecoder().decode(decrypted);
  } catch { return ''; }
}

function validProviderUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && value.length <= 300 ? value : ''; } catch { return ''; }
}

async function readAiConfig(env, includeSecrets = false) {
  const row = await env.DB.prepare('SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?').bind(aiConfigKey).first();
  const stored = (() => { try { return JSON.parse(row?.valueJson || '{}'); } catch { return {}; } })();
  const legacyAccounts = Object.entries(legacyProviders).flatMap(([name, defaults]) => {
    const entry = stored.providers?.[name] || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : entry.encryptedKey ? [{ id: `legacy-${name}`, label: '默认账号', baseUrl: entry.baseUrl, encryptedKey: entry.encryptedKey }] : [];
    return accounts.map(account => ({ ...defaults, ...account }));
  });
  const configuredAccounts = Array.isArray(stored.accounts) ? stored.accounts : legacyAccounts;
  const accounts = [];
  for (const account of configuredAccounts.slice(0, 36)) {
    const baseUrl = validProviderUrl(account?.baseUrl);
    const apiKey = await decryptConfigValue(account?.encryptedKey, env.ADMIN_CONFIG_KEY);
    if (!baseUrl || !apiKey || !validTiers.has(account?.tier)) continue;
    const apiFormat = account?.apiFormat === 'anthropic' || (!account?.apiFormat && account?.platform?.toLowerCase().includes('anthropic')) ? 'anthropic' : 'openai';
    accounts.push({ id: typeof account.id === 'string' ? account.id : id(), platform: typeof account.platform === 'string' ? account.platform.slice(0, 40) : '', apiFormat, modelName: typeof account.modelName === 'string' ? account.modelName.slice(0, 100) : '', tier: account.tier, baseUrl, ...(includeSecrets ? { apiKey } : {}) });
  }
  if (!accounts.length) {
    for (const defaults of Object.values(legacyProviders)) {
      const apiKey = env[defaults.envKey];
      if (apiKey) accounts.push({ id: `worker-${defaults.tier}`, ...defaults, ...(includeSecrets ? { apiKey } : {}) });
    }
  }
  return { systemPrompt: typeof stored.systemPrompt === 'string' && stored.systemPrompt.trim() ? stored.systemPrompt : systemPrompt, accounts: accounts.map(({ apiKey, envKey, ...account }) => ({ ...account, keyConfigured: true, ...(includeSecrets ? { apiKey } : {}) })) };
}

async function adminAiConfig(request, env) {
  const identity = await adminUser(request, env);
  if (identity.error) return json({ error: identity.error }, { status: identity.error === 'unauthorized' ? 401 : 403 });
  if (request.method === 'GET') return json(await readAiConfig(env));
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload.systemPrompt !== 'string' || !payload.systemPrompt.trim() || payload.systemPrompt.length > 12000) return badRequest('valid system prompt is required');
  const existing = await env.DB.prepare('SELECT value_json AS valueJson FROM app_settings WHERE setting_key = ?').bind(aiConfigKey).first();
  const existingConfig = (() => { try { return JSON.parse(existing?.valueJson || '{}'); } catch { return {}; } })();
  const oldAccounts = Array.isArray(existingConfig.accounts) ? existingConfig.accounts : Object.entries(legacyProviders).flatMap(([name, defaults]) => {
    const entry = existingConfig.providers?.[name] || {};
    const accounts = Array.isArray(entry.accounts) ? entry.accounts : entry.encryptedKey ? [{ id: `legacy-${name}`, baseUrl: entry.baseUrl, encryptedKey: entry.encryptedKey }] : [];
    return accounts.map(account => ({ ...defaults, ...account }));
  });
  const stored = { systemPrompt: payload.systemPrompt.trim(), accounts: [] };
  const inputAccounts = Array.isArray(payload.accounts) ? payload.accounts.slice(0, 36) : [];
  for (const input of inputAccounts) {
    const baseUrl = validProviderUrl(input?.baseUrl);
    const platform = typeof input?.platform === 'string' ? input.platform.trim().slice(0, 40) : '';
    const modelName = typeof input?.modelName === 'string' ? input.modelName.trim().slice(0, 100) : '';
    const apiFormat = input?.apiFormat === 'anthropic' ? 'anthropic' : input?.apiFormat === 'openai' ? 'openai' : '';
    if (!baseUrl || !platform || !modelName || !apiFormat || !validTiers.has(input?.tier)) return badRequest('platform, protocol, endpoint, model name, and tier are required');
    const accountId = typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.id) ? input.id : id();
    const previous = oldAccounts.find(account => account.id === accountId);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    let encryptedKey = previous?.encryptedKey || '';
    if (apiKey) {
      try { encryptedKey = await encryptConfigValue(apiKey, env.ADMIN_CONFIG_KEY); } catch { return json({ error: 'config_secret_unavailable' }, { status: 409 }); }
    }
    if (!encryptedKey) return badRequest('API Key is required for every channel');
    stored.accounts.push({ id: accountId, platform, apiFormat, modelName, tier: input.tier, baseUrl, encryptedKey });
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO app_settings (setting_key, value_json, updated_by) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP').bind(aiConfigKey, JSON.stringify(stored), identity.user.id),
    env.DB.prepare('INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), identity.user.id, 'update', 'ai_config', aiConfigKey, JSON.stringify({ accountCount: stored.accounts.length }))
  ]);
  return json(await readAiConfig(env));
}

async function adminStyles(request, env) {
  const identity = await adminUser(request, env);
  if (identity.error) return json({ error: identity.error }, { status: identity.error === 'unauthorized' ? 401 : 403 });
  const status = new URL(request.url).searchParams.get('status');
  const filter = ['approved', 'hidden'].includes(status) ? 'WHERE t.moderation_status = ?' : '';
  const result = await env.DB.prepare(`SELECT t.id, t.title, t.description, t.moderation_status AS moderationStatus, t.preview_object_key AS previewObjectKey, t.likes_count AS likes, t.uses_count AS uses, t.created_at AS createdAt, u.email AS author FROM style_templates t LEFT JOIN users u ON u.id = t.owner_id ${filter} ORDER BY CASE t.moderation_status WHEN 'approved' THEN 0 ELSE 1 END, t.created_at DESC LIMIT 80`).bind(...(filter ? [status] : [])).all();
  return json({ styles: (result.results || []).map(style => ({ ...style, previewUrl: style.previewObjectKey ? `/api/styles/${style.id}/preview` : null })) });
}

async function moderateStyle(request, env, templateId) {
  const identity = await adminUser(request, env);
  if (identity.error) return json({ error: identity.error }, { status: identity.error === 'unauthorized' ? 401 : 403 });
  const payload = await request.json().catch(() => null);
  const status = payload?.status;
  if (!['approved', 'hidden'].includes(status)) return badRequest('valid moderation status is required');
  const updated = await env.DB.prepare('UPDATE style_templates SET moderation_status = ? WHERE id = ?').bind(status, templateId).run();
  if (!updated.meta.changes) return json({ error: 'not_found' }, { status: 404 });
  await env.DB.prepare('INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), identity.user.id, 'moderate', 'style_template', templateId, JSON.stringify({ status })).run();
  return json({ id: templateId, moderationStatus: status });
}

function validDocumentPayload(payload) {
  return payload && typeof payload.content === 'string' && payload.content.trim() && payload.content.length <= 10000;
}

function styleTemplatePayload(payload) {
  const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 80) : '';
  const description = typeof payload?.description === 'string' ? payload.description.trim().slice(0, 240) : '';
  return { title, description };
}

function clientPreviewPng(payload) {
  const value = typeof payload?.previewDataUrl === 'string' ? payload.previewDataUrl : '';
  if (!value) return null;
  const encoded = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)?.[1];
  if (!encoded) return null;
  const binary = atob(encoded);
  if (binary.length < 8 || binary.length > 8 * 1024 * 1024 || binary.slice(0, 8) !== '\x89PNG\r\n\x1a\n') return null;
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
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

async function createDocumentVersionForOwner({ ownerId, document, payload, parentVersionId, env }) {
  const versionId = id();
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : document.title;
  const objectKey = `documents/${document.id}/versions/${versionId}/safe.html`;
  const design = normalizeDesign(payload.design);
  const html = createSafeDocument({ title, content: payload.content, design });

  await env.ASSETS.put(objectKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO document_versions (id, document_id, parent_version_id, content_json, html_object_key, safety_status) VALUES (?, ?, ?, ?, ?, ?)').bind(versionId, document.id, parentVersionId || document.current_version_id, JSON.stringify({ content: payload.content, design }), objectKey, 'approved'),
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

async function listDocuments(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const result = await env.DB.prepare(`SELECT d.id, d.title, d.status, d.current_version_id AS currentVersionId, d.updated_at AS updatedAt, COUNT(v.id) AS versionCount FROM documents d LEFT JOIN document_versions v ON v.document_id = d.id WHERE d.owner_id = ? GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 50`).bind(ownerId).all();
  return json({ documents: result.results || [] });
}

async function getDocument(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const document = await env.DB.prepare('SELECT id, title, status, current_version_id AS currentVersionId, updated_at AS updatedAt, (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = documents.id) AS versionCount FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });
  const requestedVersionId = new URL(request.url).searchParams.get('versionId');
  const version = await env.DB.prepare('SELECT id, content_json AS contentJson, created_at AS createdAt FROM document_versions WHERE id = ? AND document_id = ? AND safety_status = ?').bind(requestedVersionId || document.currentVersionId, document.id, 'approved').first();
  if (!version) return json({ error: 'not_found' }, { status: 404 });
  return json({ document, version: { id: version.id, ...JSON.parse(version.contentJson), createdAt: version.createdAt } });
}

async function listDocumentVersions(request, env, documentId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const document = await env.DB.prepare('SELECT id, current_version_id AS currentVersionId FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });
  const result = await env.DB.prepare('SELECT id, parent_version_id AS parentVersionId, content_json AS contentJson, created_at AS createdAt FROM document_versions WHERE document_id = ? AND safety_status = ? ORDER BY created_at DESC LIMIT 50').bind(document.id, 'approved').all();
  const versions = (result.results || []).map(version => {
    const content = JSON.parse(version.contentJson).content || '';
    return { id: version.id, parentVersionId: version.parentVersionId, createdAt: version.createdAt, title: content.trim().split(/\n/)[0].slice(0, 80), current: version.id === document.currentVersionId };
  });
  return json({ document, versions });
}

async function serveDocumentVersionPreview(request, env, documentId, versionId) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const version = await env.DB.prepare('SELECT v.html_object_key FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ? AND v.document_id = ? AND v.safety_status = ? AND d.owner_id = ?').bind(versionId, documentId, 'approved', ownerId).first();
  if (!version) return json({ error: 'not_found' }, { status: 404 });
  const object = await env.ASSETS.get(version.html_object_key);
  if (!object) return json({ error: 'not_found' }, { status: 404 });
  return new Response(object.body, { headers: privateHtmlHeaders });
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

async function listPublications(request, env) {
  const ownerId = await sessionUserId(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, { status: 401 });
  const [pages, styles] = await Promise.all([
    env.DB.prepare('SELECT p.slug, d.title, p.created_at AS createdAt FROM published_pages p JOIN documents d ON d.id = p.document_id WHERE d.owner_id = ? ORDER BY p.created_at DESC LIMIT 50').bind(ownerId).all(),
    env.DB.prepare('SELECT id, title, moderation_status AS moderationStatus, preview_object_key AS previewObjectKey, likes_count AS likes, uses_count AS uses, created_at AS createdAt FROM style_templates WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50').bind(ownerId).all()
  ]);
  const origin = new URL(request.url).origin;
  return json({
    pages: (pages.results || []).map(page => ({ ...page, url: `${origin}/p/${page.slug}` })),
    styles: (styles.results || []).map(style => ({ ...style, previewUrl: style.previewObjectKey ? `/api/styles/${style.id}/preview` : null }))
  });
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
  const exportRecord = await env.DB.prepare('SELECT object_key FROM exports WHERE document_id = ? AND version_id = ? ORDER BY created_at DESC LIMIT 1').bind(document.id, version.id).first();
  let previewObjectKey = exportRecord?.object_key;
  const clientPreview = clientPreviewPng(payload);
  if (typeof payload?.previewDataUrl === 'string' && payload.previewDataUrl && !clientPreview) return badRequest('invalid preview image');
  if (!previewObjectKey && clientPreview) {
    previewObjectKey = stylePreviewObjectKey({ templateId });
    await env.ASSETS.put(previewObjectKey, clientPreview, { httpMetadata: { contentType: 'image/png' } });
  }
  if (!previewObjectKey) {
    const sourceObject = await env.ASSETS.get(version.html_object_key);
    if (!sourceObject) return json({ error: 'not_found' }, { status: 404 });
    try {
      previewObjectKey = stylePreviewObjectKey({ templateId });
      const png = await renderHtmlToPng(env.BROWSER, await sourceObject.text());
      await env.ASSETS.put(previewObjectKey, png, { httpMetadata: { contentType: 'image/png' } });
    } catch (error) {
      console.error('style preview render failed', error);
      return json({ error: error.message === 'render_failed' ? 'render_failed' : 'render_unavailable' }, { status: 503 });
    }
  }
  try {
    await env.DB.prepare("INSERT INTO style_templates (id, owner_id, source_document_id, source_version_id, title, description, style_key, preview_object_key, moderation_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')").bind(templateId, ownerId, document.id, version.id, template.title, template.description, 'document-reference', previewObjectKey).run();
  } catch {
    return json({ error: 'already_published' }, { status: 409 });
  }
  return json({ id: templateId, ...template, moderationStatus: 'approved', previewUrl: `/api/styles/${templateId}/preview`, likes: 0, uses: 0 }, { status: 201 });
}

async function listStyleTemplates(request, env) {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : query ? 50 : 20, 1), 50);
  const viewerId = await sessionUserId(request, env);
  const filter = query ? 'WHERE t.moderation_status = \'approved\' AND (t.title LIKE ? OR t.description LIKE ?)' : "WHERE t.moderation_status = 'approved'";
  const params = query ? [viewerId || '', `%${query}%`, `%${query}%`] : [viewerId || ''];
  const result = await env.DB.prepare(`SELECT t.id, t.title, t.description, t.style_key AS style, t.preview_object_key AS previewObjectKey, t.likes_count AS likes, t.uses_count AS uses, t.created_at, u.email AS author, EXISTS(SELECT 1 FROM style_template_likes l WHERE l.template_id = t.id AND l.user_id = ?) AS liked FROM style_templates t LEFT JOIN users u ON u.id = t.owner_id ${filter} ORDER BY (t.uses_count + t.likes_count) DESC, t.uses_count DESC, t.created_at DESC LIMIT ${limit}`).bind(...params).all();
  return json({ styles: (result.results || []).map(style => ({ ...style, previewUrl: style.previewObjectKey ? `/api/styles/${style.id}/preview` : null })) });
}

async function serveStylePreview(request, env, templateId) {
  const template = await env.DB.prepare('SELECT owner_id AS ownerId, moderation_status AS moderationStatus, preview_object_key AS previewObjectKey FROM style_templates WHERE id = ?').bind(templateId).first();
  const viewerId = await sessionUserId(request, env);
  const administrator = await adminUser(request, env);
  if (!template || (template.moderationStatus !== 'approved' && template.ownerId !== viewerId && administrator.error)) return new Response('Not found', { status: 404 });
  if (!template.previewObjectKey) return new Response('Not found', { status: 404 });
  const object = await env.ASSETS.get(template.previewObjectKey);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}

async function toggleStyleLike(request, env, templateId) {
  const userId = await sessionUserId(request, env);
  if (!userId) return json({ error: 'unauthorized' }, { status: 401 });
  const template = await env.DB.prepare("SELECT id FROM style_templates WHERE id = ? AND moderation_status = 'approved'").bind(templateId).first();
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
  const template = await env.DB.prepare("SELECT t.id, t.title, t.description, t.uses_count AS uses, v.content_json FROM style_templates t JOIN document_versions v ON v.id = t.source_version_id WHERE t.id = ? AND t.moderation_status = 'approved'").bind(templateId).first();
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
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return badRequest('idempotency-key header is required');
  const payload = await request.json().catch(() => ({}));

  const document = await env.DB.prepare('SELECT id, current_version_id FROM documents WHERE id = ? AND owner_id = ?').bind(documentId, ownerId).first();
  if (!document) return json({ error: 'not_found' }, { status: 404 });
  const versionId = typeof payload?.versionId === 'string' ? payload.versionId : document.current_version_id;
  const version = await env.DB.prepare('SELECT id, html_object_key FROM document_versions WHERE id = ? AND document_id = ? AND safety_status = ?').bind(versionId, document.id, 'approved').first();
  if (!version) return json({ error: 'not_found' }, { status: 404 });

  const htmlObject = await env.ASSETS.get(version.html_object_key);
  if (!htmlObject) return json({ error: 'not_found' }, { status: 404 });

  const reservation = await reserveCloudRenderCredits({ db: env.DB, ownerId, documentId: document.id, versionId: version.id, idempotencyKey });
  if (reservation.state === 'insufficient_credits') return json({ error: 'insufficient_credits' }, { status: 402 });
  if (reservation.state === 'existing') {
    if (reservation.job.status === 'succeeded' && reservation.job.export_id) return json({ id: reservation.job.export_id, downloadUrl: `/api/exports/${reservation.job.export_id}` });
    return json({ error: 'render_in_progress' }, { status: 409 });
  }

  try {
    await env.DB.prepare("UPDATE render_jobs SET status = 'running' WHERE id = ? AND owner_id = ?").bind(reservation.job.id, ownerId).run();
    const exportId = id();
    const objectKey = exportObjectKey({ documentId, versionId: version.id, exportId });
    const png = await renderHtmlToPng(env.BROWSER, await htmlObject.text());
    await env.ASSETS.put(objectKey, png, { httpMetadata: { contentType: 'image/png' } });
    await env.DB.batch([
      env.DB.prepare('INSERT INTO exports (id, owner_id, document_id, version_id, object_key) VALUES (?, ?, ?, ?, ?)').bind(exportId, ownerId, documentId, version.id, objectKey),
      env.DB.prepare("UPDATE render_jobs SET export_id = ?, status = 'succeeded', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status = 'running'").bind(exportId, reservation.job.id, ownerId)
    ]);
    return json({ id: exportId, downloadUrl: `/api/exports/${exportId}`, credits: reservation.job.costCredits }, { status: 201 });
  } catch (error) {
    console.error('document export render failed', error);
    await refundCloudRenderCredits({ db: env.DB, ownerId, jobId: reservation.job.id, credits: reservation.job.costCredits });
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
  const parentVersionId = typeof payload.parentVersionId === 'string' ? payload.parentVersionId : null;
  if (parentVersionId && (!existingDocument || !(await env.DB.prepare('SELECT id FROM document_versions WHERE id = ? AND document_id = ? AND safety_status = ?').bind(parentVersionId, existingDocument.id, 'approved').first()))) return badRequest('invalid parent version');
  const reference = typeof payload.styleTemplateId === 'string'
    ? await env.DB.prepare("SELECT v.content_json FROM style_templates t JOIN document_versions v ON v.id = t.source_version_id WHERE t.id = ? AND t.moderation_status = 'approved'").bind(payload.styleTemplateId).first()
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
      const aiConfig = await readAiConfig(env, true);
      const generated = await generateComposition({
        modelId: payload.modelId,
        title: payload.title,
        content: payload.content,
        instruction: payload.instruction,
        referenceDesign: reference ? normalizeDesign(JSON.parse(reference.content_json).design) : undefined,
        history: payload.history,
        revision: Boolean(existingDocument),
        systemPromptOverride: aiConfig.systemPrompt,
        providerOverrides: aiConfig,
        requestKey: reservation.job.id,
        env
      });
      const { composition } = generated;
      const generatedContent = [...composition.paragraphs, composition.highlight].join('\n\n');
      const document = existingDocument
        ? await createDocumentVersionForOwner({ ownerId, document: existingDocument, parentVersionId, payload: { title: composition.title, content: generatedContent, design: composition.design }, env })
        : await createDocumentForOwner({ ownerId, payload: { title: composition.title, content: generatedContent, design: composition.design }, env });
      await env.DB.prepare("UPDATE generation_jobs SET document_id = ?, status = 'succeeded', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?").bind(document.id, reservation.job.id, ownerId).run();
      await recordGenerationTelemetry(env, reservation.job.id, generated.telemetry).catch(error => console.error('generation telemetry write failed', error));
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

    if (request.method === 'GET' && url.pathname === '/api/admin/me') return adminMe(request, env);
    if (request.method === 'GET' && url.pathname === '/api/admin/overview') return adminOverview(request, env);
    if ((request.method === 'GET' || request.method === 'PUT') && url.pathname === '/api/admin/ai-config') return adminAiConfig(request, env);
    if (request.method === 'GET' && url.pathname === '/api/admin/styles') return adminStyles(request, env);

    const adminStyleMatch = url.pathname.match(/^\/api\/admin\/styles\/([^/]+)$/);
    if (request.method === 'PATCH' && adminStyleMatch) return moderateStyle(request, env, adminStyleMatch[1]);

    if (request.method === 'GET' && url.pathname === '/api/wallet') return wallet(request, env);
    if (request.method === 'POST' && url.pathname === '/api/test-payments') return testPayment(request, env);
    if (request.method === 'GET' && url.pathname === '/api/publications') return listPublications(request, env);

    if (request.method === 'POST' && url.pathname === '/api/generation-jobs') return createGenerationJob(request, env);

    if (request.method === 'POST' && url.pathname === '/api/documents') return createDocument(request, env);
    if (request.method === 'GET' && url.pathname === '/api/documents') return listDocuments(request, env);

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (request.method === 'GET' && documentMatch) return getDocument(request, env, documentMatch[1]);

    const documentPreviewMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/preview$/);
    if (request.method === 'GET' && documentPreviewMatch) return serveDocumentVersionPreview(request, env, documentPreviewMatch[1], documentPreviewMatch[2]);

    const documentVersionsMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/versions$/);
    if (request.method === 'GET' && documentVersionsMatch) return listDocumentVersions(request, env, documentVersionsMatch[1]);

    const publishMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/publish$/);
    if (request.method === 'POST' && publishMatch) return publishDocument(request, env, publishMatch[1]);

    const publishStyleMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/styles$/);
    if (request.method === 'POST' && publishStyleMatch) return publishStyleTemplate(request, env, publishStyleMatch[1]);

    if (request.method === 'GET' && url.pathname === '/api/styles') return listStyleTemplates(request, env);

    const stylePreviewMatch = url.pathname.match(/^\/api\/styles\/([^/]+)\/preview$/);
    if (request.method === 'GET' && stylePreviewMatch) return serveStylePreview(request, env, stylePreviewMatch[1]);

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
