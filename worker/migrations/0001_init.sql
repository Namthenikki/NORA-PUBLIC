-- Likho page credits: one row per Google account, laptop, payment and voucher.

CREATE TABLE accounts (
  sub          TEXT PRIMARY KEY,        -- Google account ID
  email        TEXT NOT NULL DEFAULT '',
  balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  free_granted INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- a laptop (SHA-256 of its hardware ID) gives out free pages once
CREATE TABLE machines (
  machine    TEXT PRIMARY KEY,
  free_sub   TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);

-- one row per paid Razorpay payment link; the key makes crediting idempotent
CREATE TABLE payments (
  link_id    TEXT PRIMARY KEY,
  payment_id TEXT,
  sub        TEXT NOT NULL,
  pages      INTEGER NOT NULL,
  amount     INTEGER NOT NULL,          -- paise
  created_at INTEGER NOT NULL
);

CREATE TABLE vouchers (
  id         TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  machine    TEXT NOT NULL,
  pages      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX vouchers_by_sub ON vouchers (sub);
CREATE INDEX payments_by_sub ON payments (sub);
