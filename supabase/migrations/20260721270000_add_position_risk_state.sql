create table if not exists public.bg_position_risk_state (
  bot_id uuid primary key references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  high_water_price numeric(24,8) not null,
  updated_at timestamptz not null default now()
);
alter table public.bg_position_risk_state enable row level security;
create policy "position risk state own rows" on public.bg_position_risk_state for select using (auth.uid() = user_id);
