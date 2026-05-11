-- Migration: add statflo_identity_raw column to profiles
-- Stores the raw (un-normalized) Statflo username as detected from the browser,
-- alongside the normalized key in statflo_identity.
-- Added: 2026-05-11

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS statflo_identity_raw TEXT;

COMMENT ON COLUMN profiles.statflo_identity_raw IS
  'Raw detected Statflo username/email (e.g. John.Smith@cellularsales.com). Stored for audit; identity enforcement uses the normalized statflo_identity key.';
