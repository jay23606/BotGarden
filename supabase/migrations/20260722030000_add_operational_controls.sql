create table if not exists public.bg_user_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  entries_paused boolean not null default false,
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.bg_user_controls enable row level security;
drop policy if exists "controls own rows read" on public.bg_user_controls;
drop policy if exists "controls own rows insert" on public.bg_user_controls;
drop policy if exists "controls own rows update" on public.bg_user_controls;
create policy "controls own rows read" on public.bg_user_controls for select using (auth.uid() = user_id);
create policy "controls own rows insert" on public.bg_user_controls for insert with check (auth.uid() = user_id);
create policy "controls own rows update" on public.bg_user_controls for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.bg_worker_heartbeats (
  worker_mode text primary key check (worker_mode in ('entry-runner','risk-monitor')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running',
  summary jsonb not null default '{}'::jsonb
);

alter table public.bg_worker_heartbeats enable row level security;
drop policy if exists "authenticated users read worker health" on public.bg_worker_heartbeats;
create policy "authenticated users read worker health" on public.bg_worker_heartbeats for select to authenticated using (true);

create extension if not exists pg_cron with schema pg_catalog;
do $$ begin perform cron.unschedule('botgarden-retention-cleanup'); exception when others then null; end $$;
select cron.schedule(
  'botgarden-retention-cleanup',
  '17 4 * * *',
  $$delete from public.bg_bot_events where created_at < now() - interval '30 days';$$
);
