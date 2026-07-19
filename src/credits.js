import { getModel } from './models.js';

const id = () => crypto.randomUUID();
export const CLOUD_RENDER_CREDITS = 1;

export async function reserveGenerationCredits({ db, ownerId, documentId, modelId, idempotencyKey }) {
  const model = getModel(modelId);
  if (!model) throw new Error('unsupported_model');

  const existing = await db.prepare('SELECT id, status, cost_credits FROM generation_jobs WHERE idempotency_key = ?').bind(idempotencyKey).first();
  if (existing) return { state: 'existing', job: existing };

  const jobId = id();
  const ledgerId = id();
  const statements = [
    db.prepare('UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?').bind(model.credits, ownerId, model.credits),
    db.prepare("INSERT INTO credit_ledger (id, user_id, amount, reason, generation_job_id, idempotency_key) SELECT ?, ?, ?, 'generation', ?, ? WHERE changes() = 1").bind(ledgerId, ownerId, -model.credits, jobId, `ledger:${idempotencyKey}`),
    db.prepare("INSERT INTO generation_jobs (id, owner_id, document_id, model_id, cost_credits, status, idempotency_key) SELECT ?, ?, ?, ?, ?, 'queued', ? WHERE changes() = 1").bind(jobId, ownerId, documentId ?? null, modelId, model.credits, idempotencyKey)
  ];
  const results = await db.batch(statements);

  if (results[0].meta.changes !== 1) return { state: 'insufficient_credits' };
  return { state: 'reserved', job: { id: jobId, status: 'queued', costCredits: model.credits } };
}

export async function refundGenerationCredits({ db, ownerId, jobId, credits, errorCode = 'model_unavailable' }) {
  const refundKey = `refund:${jobId}`;
  await db.batch([
    db.prepare("UPDATE generation_jobs SET status = 'refunded', error_code = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status IN ('queued', 'running')").bind(errorCode, jobId, ownerId),
    db.prepare("INSERT INTO credit_ledger (id, user_id, amount, reason, generation_job_id, idempotency_key) SELECT ?, ?, ?, 'refund', ?, ? WHERE changes() = 1").bind(id(), ownerId, credits, jobId, refundKey),
    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1').bind(credits, ownerId)
  ]);
  return { status: 'refunded', credits };
}

export async function reserveCloudRenderCredits({ db, ownerId, documentId, versionId, idempotencyKey }) {
  const existing = await db.prepare('SELECT id, export_id, status, cost_credits FROM render_jobs WHERE idempotency_key = ? AND owner_id = ?').bind(idempotencyKey, ownerId).first();
  if (existing) return { state: 'existing', job: existing };

  const jobId = id();
  const ledgerId = id();
  const results = await db.batch([
    db.prepare('UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?').bind(CLOUD_RENDER_CREDITS, ownerId, CLOUD_RENDER_CREDITS),
    db.prepare("INSERT INTO credit_ledger (id, user_id, amount, reason, generation_job_id, idempotency_key) SELECT ?, ?, ?, 'cloud_render', ?, ? WHERE changes() = 1").bind(ledgerId, ownerId, -CLOUD_RENDER_CREDITS, jobId, `ledger:${idempotencyKey}`),
    db.prepare("INSERT INTO render_jobs (id, owner_id, document_id, version_id, cost_credits, status, idempotency_key) SELECT ?, ?, ?, ?, ?, 'queued', ? WHERE changes() = 1").bind(jobId, ownerId, documentId, versionId, CLOUD_RENDER_CREDITS, idempotencyKey)
  ]);

  if (results[0].meta.changes !== 1) return { state: 'insufficient_credits' };
  return { state: 'reserved', job: { id: jobId, costCredits: CLOUD_RENDER_CREDITS } };
}

export async function refundCloudRenderCredits({ db, ownerId, jobId, credits = CLOUD_RENDER_CREDITS }) {
  const refundKey = `refund:${jobId}`;
  await db.batch([
    db.prepare("UPDATE render_jobs SET status = 'refunded', error_code = 'render_unavailable', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status IN ('queued', 'running')").bind(jobId, ownerId),
    db.prepare("INSERT INTO credit_ledger (id, user_id, amount, reason, generation_job_id, idempotency_key) SELECT ?, ?, ?, 'refund', ?, ? WHERE changes() = 1").bind(id(), ownerId, credits, jobId, refundKey),
    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1').bind(credits, ownerId)
  ]);
}
