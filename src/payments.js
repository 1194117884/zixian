const TEST_CREDITS = 100;

export async function grantTestCredits({ db, userId }) {
  const paymentId = crypto.randomUUID();
  await db.batch([
    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').bind(TEST_CREDITS, userId),
    db.prepare("INSERT INTO credit_ledger (id, user_id, amount, reason, idempotency_key) VALUES (?, ?, ?, 'purchase', ?)").bind(crypto.randomUUID(), userId, TEST_CREDITS, `test-payment:${paymentId}`),
    db.prepare("INSERT INTO payment_orders (id, user_id, payment_mode, status, credits, amount_cents) VALUES (?, ?, 'test', 'succeeded', ?, 0)").bind(paymentId, userId, TEST_CREDITS)
  ]);
  const wallet = await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').bind(userId).first();
  return { paymentId, credits: TEST_CREDITS, balance: wallet.balance };
}
