import { getModel } from './models.js';

const id = () => crypto.randomUUID();

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
