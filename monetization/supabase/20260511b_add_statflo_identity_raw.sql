-- Migration: add statflo_identity_raw column to licenses
-- Stores the raw (un-normalized) Statflo username as detected from the browser,
-- alongside the normalized key in statflo_identity.
-- Added: 2026-05-11

ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS statflo_identity_raw TEXT;

COMMENT ON COLUMN licenses.statflo_identity_raw IS
  'Raw detected Statflo username/email (e.g. John.Smith@cellularsales.com). Stored for audit only; identity enforcement uses the normalized statflo_identity column.';
