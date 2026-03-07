CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  subscription_plan TEXT NOT NULL DEFAULT 'free'
    CHECK (subscription_plan IN ('free', 'pro', 'enterprise')),
  subscription_status TEXT NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial', 'active', 'past_due', 'cancelled', 'suspended')),
  solve_daily_limit INTEGER NOT NULL DEFAULT 20,
  debug_daily_limit INTEGER NOT NULL DEFAULT 8,
  requests_per_hour_limit INTEGER NOT NULL DEFAULT 40,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  subscription_started_at TIMESTAMPTZ DEFAULT NOW(),
  subscription_renews_at TIMESTAMPTZ
);

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS subscription_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (subscription_source IN ('manual', 'stripe'));

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('solve', 'debug', 'screenshot')),
  allowed BOOLEAN NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created_at
  ON usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
  ON usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_users_stripe_customer_id
  ON app_users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_app_users_stripe_subscription_id
  ON app_users(stripe_subscription_id);
