-- One globally leased automatic-referral-payout run per UTC day.
-- This prevents duplicate Vercel cron delivery from exceeding daily caps or
-- submitting the same payout from concurrent workers.

begin;

create table if not exists referral_auto_payout_runs (
  run_date          date primary key,
  run_token         uuid not null,
  status            text not null default 'running'
                    check (status in ('running', 'completed')),
  lease_expires_at  timestamptz not null,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  summary           jsonb not null default '{}'::jsonb
);

alter table referral_auto_payout_runs enable row level security;

drop policy if exists "service_role_all_referral_auto_payout_runs"
  on referral_auto_payout_runs;
create policy "service_role_all_referral_auto_payout_runs"
  on referral_auto_payout_runs for all to service_role
  using (true) with check (true);

create or replace function claim_referral_auto_payout_run(
  p_run_date date,
  p_run_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed boolean := false;
begin
  if p_run_date is null or p_run_token is null or
     p_lease_seconds < 60 or p_lease_seconds > 3600 then
    return false;
  end if;

  insert into referral_auto_payout_runs (
    run_date, run_token, status, lease_expires_at, started_at, completed_at, summary
  ) values (
    p_run_date, p_run_token, 'running',
    now() + make_interval(secs => p_lease_seconds), now(), null, '{}'::jsonb
  )
  on conflict (run_date) do update
    set run_token = excluded.run_token,
        status = 'running',
        lease_expires_at = excluded.lease_expires_at,
        started_at = now(),
        completed_at = null,
        summary = '{}'::jsonb
    where referral_auto_payout_runs.status = 'running'
      and referral_auto_payout_runs.lease_expires_at < now()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function finish_referral_auto_payout_run(
  p_run_date date,
  p_run_token uuid,
  p_summary jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update referral_auto_payout_runs
  set status = 'completed',
      completed_at = now(),
      lease_expires_at = now(),
      summary = coalesce(p_summary, '{}'::jsonb)
  where run_date = p_run_date
    and run_token = p_run_token
    and status = 'running';
  return found;
end;
$$;

revoke all on function claim_referral_auto_payout_run(date, uuid, integer)
  from public, anon, authenticated;
revoke all on function finish_referral_auto_payout_run(date, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function claim_referral_auto_payout_run(date, uuid, integer)
  to service_role;
grant execute on function finish_referral_auto_payout_run(date, uuid, jsonb)
  to service_role;

commit;
