-- Migration: add statflo_identity to licenses
-- Locks each StatfloBot license to a single Statflo username/email.
-- Stored on the licenses table so the lock travels with the license key.
-- Added: 2026-05-11

ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS statflo_identity TEXT;

COMMENT ON COLUMN licenses.statflo_identity IS
  'Normalized Statflo identity key (e.g. john.smith) for account-sharing protection. Set on first successful Statflo login; subsequent runs must match.';
