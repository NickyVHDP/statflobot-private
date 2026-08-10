-- Customers can read their own run summaries, but diagnostic logs remain
-- server-only for private support attachments and owner/admin review.
revoke select on table public.bot_runs from authenticated;

grant select (
  id,
  user_id,
  created_at,
  list_name,
  mode,
  status,
  sent_count,
  skipped_count,
  failed_count,
  app_version,
  platform
) on table public.bot_runs to authenticated;

revoke select (raw_log_sanitized) on table public.bot_runs from authenticated;

notify pgrst, 'reload schema';
