-- Owner-only, per-referral release of the normal 30-day payout hold.
--
-- The ledger stays append-only. An approval is a separate immutable fact that
-- makes one accrual payable early; it never changes the reward amount or the
-- original eligible_at timestamp.

begin;

create table if not exists referral_early_payout_approvals (
  attribution_id      uuid        primary key references referral_attributions(id) on delete restrict,
  referrer_user_id    uuid        not null references auth.users(id) on delete restrict,
  original_eligible_at timestamptz not null,
  approved_by_email   text        not null,
  approved_at         timestamptz not null default now()
);

alter table referral_early_payout_approvals enable row level security;

drop policy if exists "service_role_all_referral_early_payout_approvals"
  on referral_early_payout_approvals;
create policy "service_role_all_referral_early_payout_approvals"
  on referral_early_payout_approvals for all to service_role
  using (true) with check (true);

create index if not exists idx_referral_early_payout_approvals_referrer
  on referral_early_payout_approvals(referrer_user_id, approved_at desc);

create or replace function approve_referral_reward_early(
  p_attribution_id uuid,
  p_referrer_user_id uuid,
  p_approved_by_email text
)
returns table (amount_cents integer, original_eligible_at timestamptz, approved_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_accrual referral_ledger%rowtype;
  v_approved_at timestamptz := now();
begin
  if coalesce(btrim(p_approved_by_email), '') = '' then
    raise exception 'owner identity is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payout:' || p_referrer_user_id::text, 0
  ));

  select * into v_accrual
  from referral_ledger
  where attribution_id = p_attribution_id
    and referrer_user_id = p_referrer_user_id
    and entry_type = 'accrual'
  for update;

  if not found then raise exception 'referral accrual not found'; end if;
  if v_accrual.eligible_at <= now() then raise exception 'reward already cleared the hold'; end if;
  if exists (
    select 1 from referral_ledger
    where attribution_id = p_attribution_id and entry_type = 'reversal'
  ) then
    raise exception 'reversed rewards cannot be released';
  end if;

  insert into referral_early_payout_approvals (
    attribution_id, referrer_user_id, original_eligible_at,
    approved_by_email, approved_at
  ) values (
    p_attribution_id, p_referrer_user_id, v_accrual.eligible_at,
    p_approved_by_email, v_approved_at
  );

  return query select v_accrual.amount_cents, v_accrual.eligible_at, v_approved_at;
end;
$$;

revoke all on function approve_referral_reward_early(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function approve_referral_reward_early(uuid, uuid, text)
  to service_role;

-- Replace the payout reservation so a specifically approved accrual is treated
-- exactly like a naturally matured accrual. The full balance is still reserved
-- atomically, so an owner approval cannot race the daily worker or pay twice.
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

  select coalesce(sum(case
    when rl.entry_type = 'accrual' and (
      rl.eligible_at <= now() or exists (
        select 1 from referral_early_payout_approvals early
        where early.attribution_id = rl.attribution_id
      )
    ) then rl.amount_cents
    when rl.entry_type = 'reversal' and exists (
      select 1 from referral_ledger accrual
      where accrual.attribution_id = rl.attribution_id
        and accrual.entry_type = 'accrual'
        and (
          accrual.eligible_at <= now() or exists (
            select 1 from referral_early_payout_approvals early
            where early.attribution_id = accrual.attribution_id
          )
        )
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

revoke all on table referral_early_payout_approvals from anon, authenticated;
notify pgrst, 'reload schema';

commit;
