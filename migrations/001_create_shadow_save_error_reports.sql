-- Error reports for Shadow Save Bot.
-- Production runs with TypeORM synchronize disabled, so apply this once
-- against the application database before deploying the report feature.

CREATE TABLE IF NOT EXISTS shadow_save_error_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id varchar(10) NOT NULL,
  user_telegram_id bigint NOT NULL,
  username varchar(255),
  first_name varchar(255),
  platform varchar(20),
  url text,
  error_code varchar(50),
  error_detail text,
  description text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by bigint,
  resolved_by_name varchar(255)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_shadow_save_error_reports_short_id
  ON shadow_save_error_reports (short_id);

CREATE INDEX IF NOT EXISTS idx_shadow_save_error_reports_status_created
  ON shadow_save_error_reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shadow_save_error_reports_user_created
  ON shadow_save_error_reports (user_telegram_id, created_at DESC);
