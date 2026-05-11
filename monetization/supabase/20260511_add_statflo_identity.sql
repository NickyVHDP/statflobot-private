-- Migration: add statflo_identity to profiles
-- Locks each StatfloBot account to a single Statflo username/email.
-- Added: 2026-05-11

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS statflo_identity TEXT;

COMMENT ON COLUMN profiles.statflo_identity IS
  'Locked Statflo username (email) for account-sharing protection. Set on first successful Statflo login; subsequent runs must match.';
