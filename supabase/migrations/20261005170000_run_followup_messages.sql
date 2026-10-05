-- Private owner/customer conversations attached to a StatfloBot run.
-- Access is API-only through the service role; routes enforce owner or account scope.
create table if not exists public.run_followup_messages (
  id uuid primary key default gen_random_uuid(),
  bot_run_id uuid references public.bot_runs(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_role text not null check (sender_role in ('owner', 'customer')),
  body text not null check (char_length(body) between 1 and 2000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists run_followup_messages_user_created_idx
  on public.run_followup_messages (user_id, created_at desc);
create index if not exists run_followup_messages_run_created_idx
  on public.run_followup_messages (bot_run_id, created_at asc);

alter table public.run_followup_messages enable row level security;
revoke all on table public.run_followup_messages from anon, authenticated;

comment on table public.run_followup_messages is
  'Private API-only owner/customer follow-up messages associated with a bot run.';
