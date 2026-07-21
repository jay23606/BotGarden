create table if not exists public.bg_bot_status (
  bot_id uuid primary key references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id text not null,
  reason_code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists bg_status_user_checked_idx on public.bg_bot_status(user_id, checked_at desc);
alter table public.bg_bot_status enable row level security;
drop policy if exists "status own rows read" on public.bg_bot_status;
create policy "status own rows read" on public.bg_bot_status for select using (auth.uid() = user_id);
