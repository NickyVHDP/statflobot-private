-- Migration: add_early_bird_sales
-- Records confirmed early-bird lifetime purchases.
-- stripe_session_id unique constraint is the idempotency key used by:
--   - POST /api/webhooks/stripe (checkout.session.completed, mode=payment, plan=lifetime_early)
--   - reconcilePendingPurchase in lib/license.ts (guest purchase-first flow)
-- Without this constraint, webhook replays or concurrent reconcile calls could double-count.

create table if not exists early_bird_sales (
  id                 uuid        primary key default uuid_generate_v4(),
  stripe_session_id  text        not null unique,
  user_id            uuid        references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);

alter table early_bird_sales enable row level security;

-- Service role (server-side) can read/write; no client-side access needed.
create policy "service_role_all" on early_bird_sales
  for all to service_role using (true) with check (true);

create index if not exists idx_early_bird_session on early_bird_sales(stripe_session_id);
create index if not exists idx_early_bird_user    on early_bird_sales(user_id);
create index if not exists idx_early_bird_created on early_bird_sales(created_at desc);
