alter table public.bg_bots drop constraint if exists bg_bots_bot_type_check;
alter table public.bg_bots add constraint bg_bots_bot_type_check check (bot_type in ('dca','grid','signal','credit_spread'));

create table if not exists public.bg_option_spreads (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null unique references public.bg_bots(id) on delete cascade,
  spread_type text not null check (spread_type in ('bull_put_credit','bear_call_credit')),
  min_dte integer not null check (min_dte > 0),
  max_dte integer not null check (max_dte >= min_dte),
  short_delta_target numeric(6,4) not null check (short_delta_target > 0 and short_delta_target < 1),
  target_width numeric(12,2) not null check (target_width > 0),
  minimum_credit numeric(12,2) not null check (minimum_credit > 0),
  max_bid_ask_pct numeric(8,4) not null default 15 check (max_bid_ask_pct > 0),
  contracts integer not null default 1 check (contracts > 0),
  max_risk numeric(18,2) not null check (max_risk > 0),
  profit_close_pct numeric(8,4) not null default 50 check (profit_close_pct > 0 and profit_close_pct < 100),
  loss_close_multiple numeric(8,4) not null default 2 check (loss_close_multiple > 0),
  exit_dte integer not null default 7 check (exit_dte >= 0),
  created_at timestamptz not null default now()
);

alter table public.bg_option_spreads enable row level security;
drop policy if exists "option spreads through owned bots" on public.bg_option_spreads;
create policy "option spreads through owned bots" on public.bg_option_spreads for all
using (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid()))
with check (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid()));
