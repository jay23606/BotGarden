create table if not exists public.bg_worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_mode text not null check (worker_mode in ('entry-runner','risk-monitor')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,
  status text not null default 'running',
  checked_count integer not null default 0,
  submitted_count integer not null default 0,
  exit_count integer not null default 0,
  error_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb
);

create index if not exists bg_worker_runs_mode_started_idx on public.bg_worker_runs(worker_mode, started_at desc);
alter table public.bg_worker_runs enable row level security;
drop policy if exists "authenticated users read worker runs" on public.bg_worker_runs;
create policy "authenticated users read worker runs" on public.bg_worker_runs for select to authenticated using (true);

create table if not exists public.bg_reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  issue_key text not null,
  symbol text,
  asset_class text,
  classification text not null check (classification in ('unmanaged','mixed','quantity_mismatch','unattributed_fill')),
  severity text not null default 'warning' check (severity in ('warning','error')),
  status text not null default 'open' check (status in ('open','resolved')),
  details jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(user_id, issue_key)
);

create index if not exists bg_reconciliation_issues_user_status_idx on public.bg_reconciliation_issues(user_id, status, last_seen_at desc);
alter table public.bg_reconciliation_issues enable row level security;
drop policy if exists "reconciliation issues own rows read" on public.bg_reconciliation_issues;
create policy "reconciliation issues own rows read" on public.bg_reconciliation_issues for select using (auth.uid() = user_id);

do $$ begin perform cron.unschedule('botgarden-operational-audit-retention'); exception when others then null; end $$;
select cron.schedule(
  'botgarden-operational-audit-retention',
  '29 4 * * *',
  $$
    delete from public.bg_worker_runs where started_at < now() - interval '30 days';
    delete from public.bg_reconciliation_issues where status = 'resolved' and resolved_at < now() - interval '30 days';
  $$
);
