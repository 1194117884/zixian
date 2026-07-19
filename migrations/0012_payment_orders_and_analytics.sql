CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('test', 'live')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'refunded')),
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX payment_orders_by_mode_status_created_at
  ON payment_orders(payment_mode, status, created_at DESC);
