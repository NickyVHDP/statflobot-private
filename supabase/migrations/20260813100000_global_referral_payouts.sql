-- Migrate referral payouts from the unfinished Stripe Connect model to
-- Stripe Global Payouts. This is additive: legacy Connect identifiers remain
-- for audit only and are NEVER copied into Global Payout recipient fields.

begin;

alter table referral_payout_accounts
  alter column stripe_account_id drop not null,
  add column if not exists stripe_recipient_id text,
  add column if not exists stripe_payout_method_id text,
  add column if not exists payout_method_type text,
  add column if not exists payout_method_ready boolean not null default false,
  add column if not exists provider text not null default 'stripe_global_payouts';

create unique index if not exists uniq_referral_payout_accounts_recipient
  on referral_payout_accounts(stripe_recipient_id)
  where stripe_recipient_id is not null;

alter table referral_payouts drop constraint if exists referral_payouts_outbound_status_check;
alter table referral_payouts
  add column if not exists stripe_recipient_id text,
  add column if not exists stripe_payout_method_id text,
  add column if not exists stripe_outbound_payment_id text,
  add column if not exists stripe_outbound_payment_status text;

create unique index if not exists uniq_referral_payouts_outbound_payment
  on referral_payouts(stripe_outbound_payment_id)
  where stripe_outbound_payment_id is not null;

alter table referral_payouts
  add constraint referral_payouts_outbound_status_check
  check (stripe_outbound_payment_status is null or stripe_outbound_payment_status in (
    'processing', 'posted', 'failed', 'returned', 'canceled'
  ));

alter table referral_payouts drop constraint if exists referral_payouts_method_check;
alter table referral_payouts
  add constraint referral_payouts_method_check
  check (method in ('stripe_connect', 'stripe_global_payouts', 'manual'));

-- Atomically reserve the full currently eligible balance. The advisory lock
-- serializes every payout for one referrer, while the RPC keeps the payout row
-- and its ledger debit in the same transaction.
create or replace function reserve_global_referral_payout(
  p_referrer_user_id uuid,
  p_approved_by_email text,
  p_stripe_recipient_id text,
  p_stripe_payout_method_id text,
  p_threshold_cents integer
)
returns table (
  payout_id uuid,
  amount_cents integer,
  idempotency_key text,
  stripe_recipient_id text,
  stripe_payout_method_id text,
  resumed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing referral_payouts%rowtype;
  v_payout_id uuid;
  v_amount integer;
  v_key text;
begin
  if p_threshold_cents is null or p_threshold_cents < 1000 then
    raise exception 'invalid payout threshold';
  end if;
  if coalesce(btrim(p_stripe_recipient_id), '') = '' or
     coalesce(btrim(p_stripe_payout_method_id), '') = '' then
    raise exception 'global payout recipient and payout method are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payout:' || p_referrer_user_id::text, 0
  ));

  select * into v_existing
  from referral_payouts rp
  where rp.referrer_user_id = p_referrer_user_id
    and rp.status = 'processing'
  order by rp.created_at
  limit 1
  for update;

  if found then
    return query select
      v_existing.id, v_existing.amount_cents, v_existing.idempotency_key,
      v_existing.stripe_recipient_id, v_existing.stripe_payout_method_id, true;
    return;
  end if;

  -- Reversed rewards still inside their hold are skipped as a pair. Matured
  -- accrual/reversal pairs are both counted, and all historical payout debits
  -- are counted, matching getReferralBalance().
  select coalesce(sum(case
    when rl.entry_type = 'accrual' and rl.eligible_at <= now()
      then rl.amount_cents
    when rl.entry_type = 'reversal' and exists (
      select 1 from referral_ledger accrual
      where accrual.attribution_id = rl.attribution_id
        and accrual.entry_type = 'accrual'
        and accrual.eligible_at <= now()
    ) then rl.amount_cents
    when rl.entry_type = 'payout' then rl.amount_cents
    else 0
  end), 0)::integer
  into v_amount
  from referral_ledger rl
  where rl.referrer_user_id = p_referrer_user_id;

  if v_amount < p_threshold_cents then
    raise exception 'eligible balance below payout threshold';
  end if;

  v_payout_id := gen_random_uuid();
  v_key := 'referral_payout_' || v_payout_id::text;

  insert into referral_payouts (
    id, referrer_user_id, amount_cents, status, method,
    stripe_recipient_id, stripe_payout_method_id,
    idempotency_key, approved_by_email
  ) values (
    v_payout_id, p_referrer_user_id, v_amount, 'processing',
    'stripe_global_payouts', p_stripe_recipient_id,
    p_stripe_payout_method_id, v_key, p_approved_by_email
  );

  insert into referral_ledger (
    referrer_user_id, attribution_id, payout_id, entry_type,
    amount_cents, eligible_at, notes
  ) values (
    p_referrer_user_id, null, v_payout_id, 'payout',
    -v_amount, now(), 'payout:' || v_payout_id::text
  );

  return query select
    v_payout_id, v_amount, v_key,
    p_stripe_recipient_id, p_stripe_payout_method_id, false;
end;
$$;

revoke all on function reserve_global_referral_payout(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function reserve_global_referral_payout(uuid, text, text, text, integer)
  to service_role;

-- Finalize a reserved payout. Failed sends remove only the provisional payout
-- debit because no money moved. Replays are idempotent under the same lock.
create or replace function finalize_global_referral_payout(
  p_payout_id uuid,
  p_succeeded boolean,
  p_stripe_outbound_payment_id text,
  p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payout referral_payouts%rowtype;
begin
  select * into v_payout from referral_payouts rp where rp.id = p_payout_id;
  if not found then raise exception 'payout not found'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payout:' || v_payout.referrer_user_id::text, 0
  ));
  select * into v_payout
  from referral_payouts rp
  where rp.id = p_payout_id
  for update;

  -- Idempotent replay of a terminal payout. Finalizing again for the SAME
  -- outbound payment, or retrying without naming one (the ambiguous-failure
  -- restore path passes null), is a no-op success: the row is already settled
  -- and no ledger change is owed. Only a DIFFERENT outbound payment id is a
  -- real conflict, because that would mean two payments for one reservation.
  if v_payout.status = 'paid' then
    if p_stripe_outbound_payment_id is null then
      return true;
    end if;
    return v_payout.stripe_outbound_payment_id is not distinct from p_stripe_outbound_payment_id;
  end if;
  if v_payout.status <> 'processing' then return false; end if;

  if p_succeeded then
    if coalesce(btrim(p_stripe_outbound_payment_id), '') = '' then
      raise exception 'outbound payment id required';
    end if;
    update referral_payouts
    set status = 'paid',
        stripe_outbound_payment_id = p_stripe_outbound_payment_id,
        stripe_outbound_payment_status = 'posted',
        completed_at = now(),
        failure_reason = null
    where id = p_payout_id;
  else
    delete from referral_ledger
    where payout_id = p_payout_id and entry_type = 'payout';
    update referral_payouts
    set status = 'failed',
        failure_reason = left(coalesce(p_failure_reason, 'provider error'), 300)
    where id = p_payout_id;
  end if;
  return true;
end;
$$;

revoke all on function finalize_global_referral_payout(uuid, boolean, text, text)
  from public, anon, authenticated;
grant execute on function finalize_global_referral_payout(uuid, boolean, text, text)
  to service_role;

create or replace function record_global_referral_payout_submission(
  p_payout_id uuid,
  p_stripe_outbound_payment_id text,
  p_provider_status text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payout referral_payouts%rowtype;
begin
  select * into v_payout from referral_payouts where id = p_payout_id;
  if not found then raise exception 'payout not found'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payout:' || v_payout.referrer_user_id::text, 0
  ));
  select * into v_payout from referral_payouts where id = p_payout_id for update;

  if v_payout.status not in ('processing', 'paid') then return false; end if;
  if v_payout.stripe_outbound_payment_id is not null and
     v_payout.stripe_outbound_payment_id <> p_stripe_outbound_payment_id then
    raise exception 'payout is already linked to a different outbound payment';
  end if;

  update referral_payouts
  set stripe_outbound_payment_id = p_stripe_outbound_payment_id,
      stripe_outbound_payment_status = p_provider_status
  where id = p_payout_id;
  return true;
end;
$$;

revoke all on function record_global_referral_payout_submission(uuid, text, text)
  from public, anon, authenticated;
grant execute on function record_global_referral_payout_submission(uuid, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
