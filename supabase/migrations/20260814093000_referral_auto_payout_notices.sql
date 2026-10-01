-- Owner notification dedupe and automatic-payout failure blocking.
--
-- Two additions, both about not repeating yourself:
--
--   referral_owner_notices  — one row per distinct thing the owner has been
--                             told. The daily run re-evaluates everything every
--                             day; without this the owner would get the same
--                             "add $12.00" email every morning forever.
--   auto-payout blocking    — a failed or returned AUTOMATIC payout locks that
--                             recipient out of the automatic path. The reward is
--                             restored by finalize_global_referral_payout() and
--                             stays payable by hand, but the cron must not keep
--                             re-sending into whatever broke.

begin;

-- ── referral_owner_notices ───────────────────────────────────────────────────

create table if not exists referral_owner_notices (
  notice_key        text        primary key,
  kind              text        not null,
  referrer_user_id  uuid        references auth.users(id) on delete set null,
  -- The state the notice described. A DIFFERENT payload means the situation
  -- changed and the owner needs to hear it now, not in three days.
  payload           jsonb       not null default '{}'::jsonb,
  first_sent_at     timestamptz not null default now(),
  last_sent_at      timestamptz not null default now(),
  send_count        integer     not null default 1
);

alter table referral_owner_notices enable row level security;

drop policy if exists "service_role_all_referral_owner_notices" on referral_owner_notices;
create policy "service_role_all_referral_owner_notices"
  on referral_owner_notices for all to service_role
  using (true) with check (true);

create index if not exists idx_referral_owner_notices_kind
  on referral_owner_notices(kind, last_sent_at desc);

/*
 * Claim the right to send one owner notice.
 *
 * Returns true at most once per (notice_key, unchanged state, interval). The
 * claim is taken BEFORE the email is sent, deliberately: if the send then fails,
 * the owner misses one message and gets the next one. The opposite order would
 * turn a flaky mail provider into a mailbox full of identical payout alerts.
 *
 * p_min_interval = null means "say this exactly once, ever" — used for
 * per-reward notices like the purchase confirmation and the 7-day reminder,
 * where a repeat is never correct.
 */
create or replace function claim_referral_owner_notice(
  p_notice_key text,
  p_kind text,
  p_referrer_user_id uuid,
  p_payload jsonb,
  p_min_interval interval
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing referral_owner_notices%rowtype;
begin
  if coalesce(btrim(p_notice_key), '') = '' or coalesce(btrim(p_kind), '') = '' then
    return false;
  end if;

  insert into referral_owner_notices (notice_key, kind, referrer_user_id, payload)
  values (p_notice_key, p_kind, p_referrer_user_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (notice_key) do nothing;
  if found then return true; end if;

  select * into v_existing
  from referral_owner_notices
  where notice_key = p_notice_key
  for update;
  if not found then return false; end if;

  -- Changed state always sends. Unchanged state waits out the interval, and
  -- a null interval never repeats at all.
  if v_existing.payload is not distinct from coalesce(p_payload, '{}'::jsonb) then
    if p_min_interval is null then return false; end if;
    if v_existing.last_sent_at > now() - p_min_interval then return false; end if;
  end if;

  update referral_owner_notices
  set payload = coalesce(p_payload, '{}'::jsonb),
      last_sent_at = now(),
      send_count = v_existing.send_count + 1
  where notice_key = p_notice_key;
  return true;
end;
$$;

revoke all on function claim_referral_owner_notice(text, text, uuid, jsonb, interval)
  from public, anon, authenticated;
grant execute on function claim_referral_owner_notice(text, text, uuid, jsonb, interval)
  to service_role;

-- ── Automatic payout blocking ────────────────────────────────────────────────

alter table referral_payouts
  add column if not exists auto_block_applied boolean not null default false;

alter table referral_payout_accounts
  add column if not exists auto_payouts_blocked_at timestamptz,
  add column if not exists auto_payouts_blocked_reason text,
  add column if not exists auto_payout_failure_count integer not null default 0;

/*
 * Block the automatic path for the recipient behind a failed automatic payout.
 *
 * Exactly once per payout: auto_block_applied is the claim flag, so repeated
 * reconciliation of the same failure cannot inflate the failure count or move
 * the blocked_at timestamp. Only payouts approved by the automatic worker
 * qualify — a hand-approved payout that fails is the owner's to judge, and must
 * not disable automation for that recipient.
 *
 * The reward itself is already restored to the ledger by
 * finalize_global_referral_payout(). This function only decides who may try
 * again automatically, and the answer is nobody until the owner clears it.
 */
create or replace function block_referral_auto_payouts_for_payout(
  p_payout_id uuid,
  p_auto_approver text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payout referral_payouts%rowtype;
begin
  select * into v_payout from referral_payouts where id = p_payout_id for update;
  if not found then return false; end if;
  if v_payout.auto_block_applied then return false; end if;
  if v_payout.approved_by_email is distinct from p_auto_approver then return false; end if;
  if v_payout.status <> 'failed' then return false; end if;

  update referral_payouts set auto_block_applied = true where id = p_payout_id;

  update referral_payout_accounts
  set auto_payouts_blocked_at = coalesce(auto_payouts_blocked_at, now()),
      auto_payouts_blocked_reason = left(coalesce(p_reason, 'automatic payout failed'), 300),
      auto_payout_failure_count = auto_payout_failure_count + 1,
      updated_at = now()
  where referrer_user_id = v_payout.referrer_user_id;

  return true;
end;
$$;

revoke all on function block_referral_auto_payouts_for_payout(uuid, text, text)
  from public, anon, authenticated;
grant execute on function block_referral_auto_payouts_for_payout(uuid, text, text)
  to service_role;

/*
 * Owner-only release of that block.
 *
 * Clearing does not pay anything. It only makes the recipient eligible for the
 * next daily run, and every guard still applies from scratch.
 */
create or replace function clear_referral_auto_payout_block(
  p_referrer_user_id uuid,
  p_cleared_by text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(btrim(p_cleared_by), '') = '' then
    raise exception 'clearing an automatic payout block requires an owner identity';
  end if;

  update referral_payout_accounts
  set auto_payouts_blocked_at = null,
      auto_payouts_blocked_reason = null,
      updated_at = now()
  where referrer_user_id = p_referrer_user_id
    and auto_payouts_blocked_at is not null;
  return found;
end;
$$;

revoke all on function clear_referral_auto_payout_block(uuid, text)
  from public, anon, authenticated;
grant execute on function clear_referral_auto_payout_block(uuid, text)
  to service_role;

revoke all on table referral_owner_notices from anon, authenticated;

notify pgrst, 'reload schema';

commit;
