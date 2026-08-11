-- Support report lifecycle: private, account-owned support tickets.
--
-- Idempotent — safe to run more than once.
--
-- Design rules enforced here:
--   * No log bodies are stored in the cloud. Only metadata describing what the
--     private support email carried (a run id or a bare filename), so this table
--     can never become a second copy of customer diagnostics.
--   * RLS denies `anon` and `authenticated` outright. Every supported read is a
--     route handler that uses the service-role client AND filters on the
--     authenticated user id, or is gated by isAdminEmail(). There is deliberately
--     no direct PostgREST surface for this table: the row carries the customer's
--     description and contact details, and column grants would have to be
--     maintained forever to keep new columns private by default.

create extension if not exists "pgcrypto";

create table if not exists public.support_reports (
  id                          uuid        primary key default gen_random_uuid(),

  -- Customer-facing identifier. Non-secret: it identifies a report, it never
  -- authorizes access to one. 80 bits of randomness so it cannot collide.
  reference                   text        not null unique,

  -- Ownership is always derived from the verified JWT, never from the body.
  user_id                     uuid        not null references auth.users(id) on delete cascade,

  -- Set only when the run was resolved by (id, user_id) — never a raw client value.
  bot_run_id                  uuid        references public.bot_runs(id) on delete set null,

  -- Deduplicates retries of the same submission attempt.
  submission_id               uuid,

  status                      text        not null default 'received'
                                          check (status in ('received','investigating','resolved','closed')),

  subject                     text,
  description                 text,
  contact_email               text,       -- reply-to for the support inbox only
  app_version                 text,
  platform                    text,
  run_status                  text,

  -- Metadata about the attachment, never the attachment itself.
  log_attached                boolean     not null default false,
  log_reference               text,
  log_unavailable_reason      text,

  -- Immediate support-inbox email (existing behaviour), tracked so a failed
  -- delivery can be retried without losing the report.
  support_email_status        text        not null default 'pending'
                                          check (support_email_status in ('pending','sent','failed')),
  support_email_sent_at       timestamptz,
  support_email_provider_id   text,
  support_email_error         text,

  -- Owner/admin resolution.
  resolution_message          text,
  fixed_in_version            text,
  resolved_at                 timestamptz,
  resolved_by_user_id         uuid        references auth.users(id) on delete set null,
  resolved_by_email           text,

  -- Branded customer email. 'sending' is a lease: it is reclaimable after
  -- RESOLUTION_EMAIL_LEASE so a crash between provider-accept and status-write
  -- cannot wedge the report forever. Exactly-once cannot be guaranteed across
  -- the provider boundary, so the send also carries a stable idempotency key.
  resolution_email_status     text        not null default 'none'
                                          check (resolution_email_status in ('none','sending','sent','failed')),
  resolution_email_attempted_at timestamptz,
  resolution_email_attempts   int         not null default 0,
  resolution_email_sent_at    timestamptz,
  resolution_email_provider_id text,
  resolution_email_error      text,

  -- In-app notice acknowledgement. Server-side so it is reliable across devices.
  acknowledged_at             timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Re-runnable column adds for an environment that already has an older shape.
alter table public.support_reports add column if not exists submission_id                 uuid;
alter table public.support_reports add column if not exists log_unavailable_reason        text;
alter table public.support_reports add column if not exists resolution_email_attempted_at timestamptz;
alter table public.support_reports add column if not exists resolution_email_attempts     int not null default 0;
alter table public.support_reports add column if not exists resolved_by_user_id           uuid references auth.users(id) on delete set null;
alter table public.support_reports add column if not exists resolved_by_email             text;

-- One report per submission attempt, so a client retry after a timeout updates
-- the existing row instead of creating a duplicate ticket.
create unique index if not exists idx_support_reports_submission
  on public.support_reports(user_id, submission_id)
  where submission_id is not null;

create index if not exists idx_support_reports_user_created
  on public.support_reports(user_id, created_at desc);

-- Drives the desktop startup check: this user's resolved-but-unseen notices.
create index if not exists idx_support_reports_pending_notice
  on public.support_reports(user_id, resolved_at desc)
  where status = 'resolved' and acknowledged_at is null;

-- Owner queue: reports still needing attention, and failed support emails.
create index if not exists idx_support_reports_open
  on public.support_reports(created_at desc)
  where status in ('received','investigating');

create or replace function public.touch_support_reports_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_support_reports_updated_at on public.support_reports;
create trigger trg_support_reports_updated_at
  before update on public.support_reports
  for each row execute function public.touch_support_reports_updated_at();

-- ── Access control ───────────────────────────────────────────────────────────
alter table public.support_reports enable row level security;

-- No policy for anon/authenticated: RLS denies by default, and the grants are
-- revoked as well so a future policy cannot silently open the table.
revoke all on table public.support_reports from anon;
revoke all on table public.support_reports from authenticated;

drop policy if exists "service_role_all" on public.support_reports;
create policy "service_role_all" on public.support_reports
  for all to service_role using (true) with check (true);

comment on table public.support_reports is
  'Private support tickets. Customer access is only via authenticated Next.js routes using the service-role client filtered by user_id; owner access is gated by isAdminEmail(). Never stores log bodies.';

notify pgrst, 'reload schema';
