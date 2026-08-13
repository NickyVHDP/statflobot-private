-- Tiered lifetime referral rewards.
--
-- This migration keeps the ledger append-only while moving reward selection
-- into one serialized database transaction.  Application-side count-then-
-- insert logic cannot safely assign tiers when two Stripe webhooks for the
-- same referrer arrive together.

-- The whole migration is one transaction: either every constraint, index and
-- backfill below lands, or nothing does. A partially applied tier migration
-- would leave reward snapshots half-populated and money-affecting CHECK
-- constraints missing, with no safe "fix it forward from the middle" state.
begin;

-- Preflight. These checks run BEFORE any DDL or DML, so incompatible
-- production data aborts the migration with an actionable message instead of
-- failing halfway through with an opaque constraint violation.
do $preflight$
declare
  v_bad_attribution_plans text;
  v_bad_reservation_plans text;
  v_dup_emails            text;
  v_dup_users             text;
  v_dup_payment_intents   text;
begin
  select string_agg(distinct coalesce(plan_code, '<null>'), ', ')
  into v_bad_attribution_plans
  from referral_attributions
  where plan_code is null or plan_code not in ('lifetime_early', 'lifetime_standard');
  if v_bad_attribution_plans is not null then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'referral_attributions contains legacy plan_code values incompatible with '
        || 'referral_attributions_lifetime_only: %s', v_bad_attribution_plans),
      hint = 'Remap or archive those rows to lifetime_early/lifetime_standard before re-running this migration.';
  end if;

  select string_agg(distinct coalesce(plan_code, '<null>'), ', ')
  into v_bad_reservation_plans
  from referral_reservations
  where plan_code is null or plan_code not in ('lifetime_early', 'lifetime_standard');
  if v_bad_reservation_plans is not null then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'referral_reservations contains legacy plan_code values incompatible with '
        || 'referral_reservations_lifetime_only: %s', v_bad_reservation_plans),
      hint = 'Remap or delete those non-lifetime reservation rows before re-running this migration.';
  end if;

  select string_agg(email_key, ', ')
  into v_dup_emails
  from (
    select lower(referred_email) as email_key
    from referral_attributions
    group by lower(referred_email)
    having count(*) > 1
    limit 20
  ) d;
  if v_dup_emails is not null then
    raise exception using
      errcode = 'unique_violation',
      message = format(
        'referral_attributions has duplicate normalized referred_email rows, so '
        || 'uniq_referral_attribution_referred_email cannot be created: %s', v_dup_emails),
      hint = 'Exactly one referrer may be rewarded per buyer. Reconcile the duplicates (keep the earliest paid attribution) before re-running.';
  end if;

  select string_agg(referred_user_id::text, ', ')
  into v_dup_users
  from (
    select referred_user_id
    from referral_attributions
    where referred_user_id is not null
    group by referred_user_id
    having count(*) > 1
    limit 20
  ) d;
  if v_dup_users is not null then
    raise exception using
      errcode = 'unique_violation',
      message = format(
        'referral_attributions has duplicate referred_user_id rows, so '
        || 'uniq_referral_attribution_referred_user cannot be created: %s', v_dup_users),
      hint = 'Reconcile the duplicate buyer attributions before re-running.';
  end if;

  select string_agg(stripe_payment_intent_id, ', ')
  into v_dup_payment_intents
  from (
    select stripe_payment_intent_id
    from referral_attributions
    where stripe_payment_intent_id is not null
    group by stripe_payment_intent_id
    having count(*) > 1
    limit 20
  ) d;
  if v_dup_payment_intents is not null then
    raise exception using
      errcode = 'unique_violation',
      message = format(
        'referral_attributions has duplicate stripe_payment_intent_id rows, so '
        || 'uniq_referral_attribution_payment_intent cannot be created: %s', v_dup_payment_intents),
      hint = 'One PaymentIntent may fund at most one attribution. Reconcile before re-running.';
  end if;
end
$preflight$;

alter table referral_attributions
  add column if not exists lifetime_sequence      integer,
  add column if not exists qualified_position     integer,
  add column if not exists reward_tier_cents      integer,
  add column if not exists reward_cents           integer,
  add column if not exists sale_amount_cents      integer,
  add column if not exists reward_basis_cents     integer,
  add column if not exists currency               text;

-- Only the two real Stripe lifetime products may ever earn a reward. The
-- earlier prefix constraint accepted arbitrary values such as lifetime_test.
alter table referral_attributions
  drop constraint if exists referral_attributions_lifetime_only;
alter table referral_attributions
  add constraint referral_attributions_lifetime_only
    check (plan_code in ('lifetime_early', 'lifetime_standard'));
alter table referral_reservations
  drop constraint if exists referral_reservations_lifetime_only;
alter table referral_reservations
  add constraint referral_reservations_lifetime_only
    check (plan_code in ('lifetime_early', 'lifetime_standard'));

-- Existing rows were created under the original flat-$10 program. Preserve
-- that exact historical value; never retroactively apply the new tiers.
with ranked as (
  select
    ra.id,
    row_number() over (
      partition by ra.referrer_user_id
      order by ra.created_at, ra.id
    )::integer as seq,
    coalesce((
      select rl.amount_cents
      from referral_ledger rl
      where rl.attribution_id = ra.id and rl.entry_type = 'accrual'
      limit 1
    ), 1000)::integer as historical_reward
  from referral_attributions ra
)
update referral_attributions ra
set
  lifetime_sequence  = coalesce(ra.lifetime_sequence, ranked.seq),
  qualified_position = coalesce(ra.qualified_position, ranked.seq),
  reward_tier_cents  = coalesce(ra.reward_tier_cents, ranked.historical_reward),
  reward_cents       = coalesce(ra.reward_cents, ranked.historical_reward),
  -- The old integration did not snapshot sale values. Use the smallest basis
  -- consistent with the 40% guard and mark it as historical in the comments;
  -- all new rows receive the real Stripe values.
  reward_basis_cents = coalesce(ra.reward_basis_cents, ceiling(ranked.historical_reward / 0.40)::integer),
  sale_amount_cents  = coalesce(ra.sale_amount_cents, ceiling(ranked.historical_reward / 0.40)::integer),
  currency           = coalesce(ra.currency, 'usd')
from ranked
where ranked.id = ra.id;

alter table referral_attributions
  alter column lifetime_sequence  set not null,
  alter column qualified_position set not null,
  alter column reward_tier_cents  set not null,
  alter column reward_cents       set not null,
  alter column sale_amount_cents  set not null,
  alter column reward_basis_cents set not null,
  alter column currency           set not null;

alter table referral_attributions
  add constraint referral_attributions_positive_sequence
    check (lifetime_sequence > 0 and qualified_position > 0),
  add constraint referral_attributions_reward_snapshot_valid
    check (
      reward_tier_cents > 0 and
      reward_cents > 0 and
      reward_cents <= reward_tier_cents and
      reward_basis_cents > 0 and
      sale_amount_cents > 0 and
      reward_basis_cents <= sale_amount_cents and
      reward_cents <= floor(reward_basis_cents * 0.40)
    ),
  add constraint referral_attributions_currency_usd
    check (currency = 'usd');

create unique index if not exists uniq_referral_attribution_lifetime_sequence
  on referral_attributions(referrer_user_id, lifetime_sequence);

-- One human purchase can reward at most one referrer, even if concurrent
-- Checkout Sessions race before the first webhook provisions access.
create unique index if not exists uniq_referral_attribution_referred_email
  on referral_attributions(lower(referred_email));
create unique index if not exists uniq_referral_attribution_referred_user
  on referral_attributions(referred_user_id)
  where referred_user_id is not null;
create unique index if not exists uniq_referral_attribution_payment_intent
  on referral_attributions(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- Stripe does not guarantee webhook ordering. A refund/dispute can arrive
-- before checkout.session.completed has created the attribution. Preserve that
-- fact so the later accrual is immediately neutralized instead of creating a
-- reward for a purchase that was already returned or disputed.
create table if not exists referral_reversal_intents (
  id                        uuid        primary key default gen_random_uuid(),
  stripe_payment_intent_id  text,
  stripe_session_id         text,
  stripe_event_id           text        not null unique,
  cause                     text        not null check (cause in ('refund', 'dispute')),
  created_at                timestamptz not null default now(),
  applied_at                timestamptz,
  constraint referral_reversal_intents_identifier_required check (
    stripe_payment_intent_id is not null or stripe_session_id is not null
  )
);

alter table referral_reversal_intents enable row level security;
create policy "service_role_all_referral_reversal_intents"
  on referral_reversal_intents for all to service_role
  using (true) with check (true);

-- Defense in depth, matching every other referral table: browser sessions get
-- no direct PostgREST privileges even though RLS is enabled. This table records
-- refund/dispute facts keyed to Stripe identifiers.
revoke all on table referral_reversal_intents from anon, authenticated;
create index if not exists idx_referral_reversal_intents_pi
  on referral_reversal_intents(stripe_payment_intent_id);
create index if not exists idx_referral_reversal_intents_session
  on referral_reversal_intents(stripe_session_id);

-- One function owns attribution creation, tier assignment and ledger accrual.
-- Locking the referrer's code row serializes concurrent purchases without
-- introducing a cached balance or mutable tier counter.
create or replace function accrue_tiered_referral(
  p_stripe_session_id         text,
  p_stripe_payment_intent_id  text,
  p_referral_code_id          uuid,
  p_referral_code             text,
  p_referrer_user_id          uuid,
  p_referred_user_id          uuid,
  p_referred_email            text,
  p_plan_code                 text,
  p_terms_version             text,
  p_terms_accepted_at         timestamptz,
  p_stripe_event_id           text,
  p_sale_amount_cents         integer,
  p_reward_basis_cents        integer,
  p_currency                  text,
  p_purchased_at              timestamptz,
  p_eligible_at               timestamptz
)
returns table (
  attribution_id      uuid,
  created             boolean,
  reward_cents        integer,
  lifetime_sequence   integer,
  qualified_position  integer,
  reward_tier_cents   integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing              referral_attributions%rowtype;
  v_attribution_id        uuid;
  v_lifetime_sequence     integer;
  v_qualified_position    integer;
  v_reward_tier_cents     integer;
  v_reward_cents          integer;
  v_cap_cents             integer;
  v_reversal_cause        text;
begin
  if p_stripe_session_id is null or btrim(p_stripe_session_id) = '' then
    raise exception 'stripe_session_id is required';
  end if;
  if p_plan_code is null or p_plan_code not in ('lifetime_early', 'lifetime_standard') then
    raise exception 'referrals are lifetime-only';
  end if;
  if lower(coalesce(p_currency, '')) <> 'usd' then
    raise exception 'referral rewards currently require USD';
  end if;
  if p_referrer_user_id = p_referred_user_id then
    raise exception 'self-referral is not allowed';
  end if;
  if coalesce(btrim(p_referred_email), '') = '' then
    raise exception 'referred email is required';
  end if;
  if exists (
    select 1 from auth.users u
    where u.id = p_referrer_user_id
      and lower(btrim(coalesce(u.email, ''))) = lower(btrim(p_referred_email))
  ) then
    raise exception 'self-referral email is not allowed';
  end if;
  if p_referred_user_id is not null and exists (
    select 1
    from licenses buyer
    join licenses referrer
      on regexp_replace(lower(coalesce(buyer.statflo_identity, '')), '@cellularsales[.]com$', '') =
         regexp_replace(lower(coalesce(referrer.statflo_identity, '')), '@cellularsales[.]com$', '')
    where buyer.user_id = p_referred_user_id
      and referrer.user_id = p_referrer_user_id
      and coalesce(btrim(buyer.statflo_identity), '') <> ''
  ) then
    raise exception 'self-referral Statflo identity is not allowed';
  end if;
  if p_sale_amount_cents <= 0 or p_reward_basis_cents <= 0
     or p_reward_basis_cents > p_sale_amount_cents then
    raise exception 'invalid sale amount snapshot';
  end if;

  -- Shared payment mutex with reverse_tiered_referral(). This closes the
  -- out-of-order race where a refund could commit just before the attribution.
  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payment:' || coalesce(p_stripe_payment_intent_id, p_stripe_session_id), 0
  ));

  -- A second lock keyed to the normalized buyer closes the two-session race:
  -- only the first paid lifetime purchase may reward any referrer.
  perform pg_advisory_xact_lock(hashtextextended(
    'referral-buyer:' || lower(btrim(p_referred_email)), 0
  ));

  -- Fast idempotent replay path. A guest reconciliation may attach the user
  -- id later, but no monetary snapshot is changed.
  select * into v_existing
  from referral_attributions ra
  where ra.stripe_session_id = p_stripe_session_id;

  if found then
    if p_referred_user_id is not null and v_existing.referred_user_id is null then
      update referral_attributions ra
      set referred_user_id = p_referred_user_id
      where ra.id = v_existing.id and ra.referred_user_id is null;
    end if;
    return query select
      v_existing.id, false, v_existing.reward_cents,
      v_existing.lifetime_sequence, v_existing.qualified_position,
      v_existing.reward_tier_cents;
    return;
  end if;

  select * into v_existing
  from referral_attributions ra
  where lower(ra.referred_email) = lower(btrim(p_referred_email))
     or (p_referred_user_id is not null and ra.referred_user_id = p_referred_user_id)
  order by ra.created_at
  limit 1;
  if found then
    return query select
      v_existing.id, false, v_existing.reward_cents,
      v_existing.lifetime_sequence, v_existing.qualified_position,
      v_existing.reward_tier_cents;
    return;
  end if;

  -- The code row is the stable per-referrer mutex. Do not require status=active:
  -- checkout already froze a valid attribution before payment completed.
  perform 1
  from referral_codes rc
  where rc.id = p_referral_code_id
    and rc.referrer_user_id = p_referrer_user_id
    and rc.code = p_referral_code
  for update;
  if not found then
    raise exception 'referral code snapshot does not match referrer';
  end if;

  -- A same-session caller might have waited behind the lock holder above.
  -- Recheck after acquiring the mutex so it receives the idempotent result
  -- instead of surfacing a unique-constraint error.
  select * into v_existing
  from referral_attributions ra
  where ra.stripe_session_id = p_stripe_session_id;
  if found then
    if p_referred_user_id is not null and v_existing.referred_user_id is null then
      update referral_attributions ra
      set referred_user_id = p_referred_user_id
      where ra.id = v_existing.id and ra.referred_user_id is null;
    end if;
    return query select
      v_existing.id, false, v_existing.reward_cents,
      v_existing.lifetime_sequence, v_existing.qualified_position,
      v_existing.reward_tier_cents;
    return;
  end if;

  select coalesce(max(ra.lifetime_sequence), 0) + 1
  into v_lifetime_sequence
  from referral_attributions ra
  where ra.referrer_user_id = p_referrer_user_id;

  -- Net-qualified means a paid accrual exists and no reversal exists. A
  -- reversal lowers only future tier progression; historical sequence and
  -- rewards remain immutable.
  select count(*)::integer + 1
  into v_qualified_position
  from referral_attributions ra
  where ra.referrer_user_id = p_referrer_user_id
    and exists (
      select 1 from referral_ledger accrual
      where accrual.attribution_id = ra.id and accrual.entry_type = 'accrual'
    )
    and not exists (
      select 1 from referral_ledger reversal
      where reversal.attribution_id = ra.id and reversal.entry_type = 'reversal'
    );

  v_reward_tier_cents := case
    when p_plan_code = 'lifetime_standard' and v_qualified_position <= 3 then 1500
    when p_plan_code = 'lifetime_standard' and v_qualified_position <= 5 then 2000
    when p_plan_code = 'lifetime_standard' then 2500
    when v_qualified_position <= 3 then 1000
    when v_qualified_position <= 5 then 1500
    else 2000
  end;
  v_cap_cents := floor(p_reward_basis_cents * 0.40)::integer;
  v_reward_cents := least(v_reward_tier_cents, v_cap_cents);
  if v_reward_cents <= 0 then
    raise exception 'purchase amount is too small for a referral reward';
  end if;

  insert into referral_attributions (
    stripe_session_id, stripe_payment_intent_id,
    referral_code_id, referral_code, referrer_user_id,
    referred_user_id, referred_email, plan_code,
    terms_version, terms_accepted_at, created_at,
    lifetime_sequence, qualified_position,
    reward_tier_cents, reward_cents,
    sale_amount_cents, reward_basis_cents, currency
  ) values (
    p_stripe_session_id, p_stripe_payment_intent_id,
    p_referral_code_id, p_referral_code, p_referrer_user_id,
    p_referred_user_id, lower(btrim(p_referred_email)), p_plan_code,
    p_terms_version, p_terms_accepted_at, coalesce(p_purchased_at, now()),
    v_lifetime_sequence, v_qualified_position,
    v_reward_tier_cents, v_reward_cents,
    p_sale_amount_cents, p_reward_basis_cents, lower(p_currency)
  )
  returning id into v_attribution_id;

  insert into referral_ledger (
    referrer_user_id, attribution_id, entry_type, amount_cents,
    eligible_at, stripe_event_id,
    notes
  ) values (
    p_referrer_user_id, v_attribution_id, 'accrual', v_reward_cents,
    p_eligible_at, p_stripe_event_id,
    format('tier:%s qualified_position:%s lifetime_sequence:%s',
      v_reward_tier_cents, v_qualified_position, v_lifetime_sequence)
  );

  -- If Stripe delivered a refund/dispute before checkout completion, make the
  -- exact compensating entry in this same transaction. The historical reward
  -- snapshot remains immutable, while its payable balance is immediately zero.
  select rri.cause into v_reversal_cause
  from referral_reversal_intents rri
  where rri.applied_at is null
    and (
      (p_stripe_payment_intent_id is not null and
       rri.stripe_payment_intent_id = p_stripe_payment_intent_id) or
      (rri.stripe_session_id = p_stripe_session_id)
    )
  order by rri.created_at
  limit 1;

  if found then
    insert into referral_ledger (
      referrer_user_id, attribution_id, entry_type, amount_cents,
      eligible_at, stripe_event_id, notes
    )
    select
      p_referrer_user_id, v_attribution_id, 'reversal', -v_reward_cents,
      now(), rri.stripe_event_id, format('reversal:%s before-accrual', v_reversal_cause)
    from referral_reversal_intents rri
    where rri.applied_at is null
      and rri.cause = v_reversal_cause
      and (
        (p_stripe_payment_intent_id is not null and
         rri.stripe_payment_intent_id = p_stripe_payment_intent_id) or
        (rri.stripe_session_id = p_stripe_session_id)
      )
    order by rri.created_at
    limit 1;

    update referral_reversal_intents rri
    set applied_at = now()
    where rri.applied_at is null
      and (
        (p_stripe_payment_intent_id is not null and
         rri.stripe_payment_intent_id = p_stripe_payment_intent_id) or
        (rri.stripe_session_id = p_stripe_session_id)
      );
  end if;

  return query select
    v_attribution_id, true, v_reward_cents,
    v_lifetime_sequence, v_qualified_position, v_reward_tier_cents;
end;
$$;

revoke all on function accrue_tiered_referral(
  text, text, uuid, text, uuid, uuid, text, text, text, timestamptz,
  text, integer, integer, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function accrue_tiered_referral(
  text, text, uuid, text, uuid, uuid, text, text, text, timestamptz,
  text, integer, integer, text, timestamptz, timestamptz
) to service_role;

-- Reversals take the SAME per-referrer lock as accruals. This makes a refund
-- racing a new purchase deterministic: whichever locks first defines the net
-- qualified count used by the next reward, and neither can observe a half-state.
create or replace function reverse_tiered_referral(
  p_stripe_payment_intent_id text,
  p_stripe_session_id        text,
  p_stripe_event_id          text,
  p_cause                   text
)
returns table (
  reversed           boolean,
  attribution_id     uuid,
  referrer_user_id   uuid,
  stripe_session_id  text,
  amount_cents       integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attr     referral_attributions%rowtype;
  v_accrual  referral_ledger%rowtype;
  v_existing referral_ledger%rowtype;
begin
  if p_cause not in ('refund', 'dispute') then
    raise exception 'invalid referral reversal cause';
  end if;

  if p_stripe_payment_intent_id is null and p_stripe_session_id is null then
    return;
  end if;

  -- Same payment mutex and lock ordering as accrue_tiered_referral(): payment
  -- first, then referrer code. Whichever webhook wins commits a state the other
  -- can observe, so neither event can be lost between lookup and insert.
  perform pg_advisory_xact_lock(hashtextextended(
    'referral-payment:' || coalesce(p_stripe_payment_intent_id, p_stripe_session_id), 0
  ));

  insert into referral_reversal_intents (
    stripe_payment_intent_id, stripe_session_id, stripe_event_id, cause
  ) values (
    p_stripe_payment_intent_id, p_stripe_session_id, p_stripe_event_id, p_cause
  )
  on conflict (stripe_event_id) do nothing;

  if p_stripe_payment_intent_id is not null then
    select * into v_attr from referral_attributions ra
    where ra.stripe_payment_intent_id = p_stripe_payment_intent_id;
  elsif p_stripe_session_id is not null then
    select * into v_attr from referral_attributions ra
    where ra.stripe_session_id = p_stripe_session_id;
  end if;
  if not found then return; end if;

  perform 1 from referral_codes rc
  where rc.id = v_attr.referral_code_id
  for update;
  if not found then
    raise exception 'referral code row missing for attribution';
  end if;

  select * into v_existing from referral_ledger rl
  where rl.attribution_id = v_attr.id and rl.entry_type = 'reversal';
  if found then
    update referral_reversal_intents
    set applied_at = coalesce(applied_at, now())
    where stripe_event_id = p_stripe_event_id;
    return query select
      false, v_attr.id, v_attr.referrer_user_id, v_attr.stripe_session_id,
      v_existing.amount_cents;
    return;
  end if;

  select * into v_accrual from referral_ledger rl
  where rl.attribution_id = v_attr.id and rl.entry_type = 'accrual';
  if not found or v_accrual.amount_cents <= 0 then
    raise exception 'referral accrual missing for attribution';
  end if;

  insert into referral_ledger (
    referrer_user_id, attribution_id, entry_type, amount_cents,
    eligible_at, stripe_event_id, notes
  ) values (
    v_attr.referrer_user_id, v_attr.id, 'reversal', -v_accrual.amount_cents,
    now(), p_stripe_event_id, format('reversal:%s', p_cause)
  );

  update referral_reversal_intents
  set applied_at = now()
  where stripe_event_id = p_stripe_event_id;

  return query select
    true, v_attr.id, v_attr.referrer_user_id, v_attr.stripe_session_id,
    -v_accrual.amount_cents;
end;
$$;

revoke all on function reverse_tiered_referral(text, text, text, text)
  from public, anon, authenticated;
grant execute on function reverse_tiered_referral(text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
