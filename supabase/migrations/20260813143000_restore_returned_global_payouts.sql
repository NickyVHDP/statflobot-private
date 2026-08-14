-- Stripe can mark an outbound payment posted before the receiving bank later
-- returns it. Reopen the reserved referral balance exactly once when that
-- happens. The application records the latest provider status before calling
-- this function, so stripe_outbound_payment_status remains `returned`.

begin;

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

  if v_payout.status = 'paid' then
    if p_succeeded then
      if p_stripe_outbound_payment_id is null then return true; end if;
      return v_payout.stripe_outbound_payment_id is not distinct from
        p_stripe_outbound_payment_id;
    end if;

    -- A bank return after `posted` means the recipient did not keep the money.
    -- Remove the single reservation debit so the reward becomes eligible
    -- again. The row lock and terminal state make concurrent replays no-ops.
    if p_stripe_outbound_payment_id is null or
       v_payout.stripe_outbound_payment_id is distinct from
         p_stripe_outbound_payment_id then
      return false;
    end if;
    delete from referral_ledger
    where payout_id = p_payout_id and entry_type = 'payout';
    update referral_payouts
    set status = 'failed',
        failure_reason = left(coalesce(p_failure_reason, 'provider returned payout'), 300),
        completed_at = now()
    where id = p_payout_id;
    return true;
  end if;

  -- Concurrent or repeated reconciliation of the same failure must succeed
  -- without deleting any additional ledger rows.
  if v_payout.status = 'failed' then
    return not p_succeeded and (
      p_stripe_outbound_payment_id is null or
      v_payout.stripe_outbound_payment_id is not distinct from
        p_stripe_outbound_payment_id
    );
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

notify pgrst, 'reload schema';

commit;
