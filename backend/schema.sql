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
    CHECK (subscription_source IN ('manual', 'stripe', 'dodo'));

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_subscription_source_check;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_subscription_source_check
  CHECK (subscription_source IN ('manual', 'stripe', 'dodo'));

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS dodo_customer_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS dodo_subscription_id TEXT UNIQUE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS dodo_product_id TEXT;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('solve', 'debug', 'screenshot', 'live_interview', 'computer_use')),
  allowed BOOLEAN NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE usage_events
  DROP CONSTRAINT IF EXISTS usage_events_action_check;

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_action_check
  CHECK (action IN ('solve', 'debug', 'screenshot', 'live_interview', 'computer_use'));

CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'general'
    CHECK (mode IN ('general', 'follow_up', 'live_interview', 'computer_use')),
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_threads
  DROP CONSTRAINT IF EXISTS chat_threads_mode_check;

ALTER TABLE chat_threads
  ADD CONSTRAINT chat_threads_mode_check
  CHECK (mode IN ('general', 'follow_up', 'live_interview', 'computer_use'));

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_pairing_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  pairing_token_hash TEXT NOT NULL UNIQUE,
  desktop_device_name TEXT NOT NULL,
  mobile_device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paired', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  paired_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS phone_relay_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL REFERENCES phone_pairing_sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('mobile', 'desktop')),
  event_type TEXT NOT NULL CHECK (event_type IN ('clipboard', 'otp', 'link', 'note')),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  author_name TEXT,
  created_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('google', 'notion')),
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'error', 'revoked')),
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_type TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  access_token_expires_at TIMESTAMPTZ,
  external_account_id TEXT,
  external_account_email TEXT,
  external_account_name TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
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
CREATE INDEX IF NOT EXISTS idx_app_users_dodo_customer_id
  ON app_users(dodo_customer_id);
CREATE INDEX IF NOT EXISTS idx_app_users_dodo_subscription_id
  ON app_users(dodo_subscription_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user_last_message_at
  ON chat_threads(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created_at
  ON chat_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_phone_pairing_sessions_user_status
  ON phone_pairing_sessions(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_relay_events_pairing_created_at
  ON phone_relay_events(pairing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_relay_events_user_created_at
  ON phone_relay_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_posts_published_at
  ON research_posts(published_at DESC, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_user_provider
  ON user_integrations(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_user_integrations_user_updated_at
  ON user_integrations(user_id, updated_at DESC);
