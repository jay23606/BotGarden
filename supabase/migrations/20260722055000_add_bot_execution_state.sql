create table if not exists public.bg_bot_execution_state (
  bot_id uuid primary key references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_entry_fill_at timestamptz,
  last_exit_fill_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists bg_bot_execution_state_user_idx on public.bg_bot_execution_state(user_id);
alter table public.bg_bot_execution_state enable row level security;
drop policy if exists "execution state own rows read" on public.bg_bot_execution_state;
create policy "execution state own rows read" on public.bg_bot_execution_state for select using (auth.uid() = user_id);
