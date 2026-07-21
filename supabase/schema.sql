create extension if not exists pgcrypto;

create table if not exists public.bg_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bg_broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('alpaca')),
  environment text not null default 'paper' check (environment in ('paper','live')),
  account_number text,
  status text not null default 'pending' check (status in ('pending','connected','error','revoked')),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, broker, environment)
);

-- Deliberately has no client RLS policies. Only the service-role Edge Function can access it.
create table if not exists public.bg_broker_credentials (
  connection_id uuid primary key references public.bg_broker_connections(id) on delete cascade,
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_secret_ciphertext text not null,
  api_secret_iv text not null,
  encryption_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.bg_bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.bg_broker_connections(id) on delete set null,
  name text not null check (char_length(name) between 1 and 100),
  bot_type text not null default 'dca' check (bot_type in ('dca','grid','signal','credit_spread','option_strategy')),
  status text not null default 'active' check (status in ('draft','active','paused','stopped','error')),
  broker text not null default 'alpaca',
  environment text not null default 'paper' check (environment in ('paper','live')),
  asset_class text not null check (asset_class in ('equity','option')),
  symbol text not null,
  direction text not null default 'long' check (direction in ('long','short')),
  max_allocation numeric(18,2) not null check (max_allocation > 0),
  max_active_trades integer not null default 1 check (max_active_trades between 1 and 100),
  start_condition jsonb not null default '{"type":"immediate"}'::jsonb,
  take_profit_pct numeric(9,4) check (take_profit_pct > 0),
  stop_loss_pct numeric(9,4) check (stop_loss_pct > 0),
  cooldown_seconds integer not null default 0 check (cooldown_seconds >= 0),
  session_policy text not null default 'regular' check (session_policy in ('regular','extended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bg_averaging_steps (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bg_bots(id) on delete cascade,
  step_number integer not null check (step_number >= 0),
  deviation_pct numeric(12,6) not null check (deviation_pct >= 0),
  order_amount numeric(18,2) not null check (order_amount > 0),
  condition jsonb,
  created_at timestamptz not null default now(),
  unique(bot_id, step_number)
);

create table if not exists public.bg_option_spreads (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null unique references public.bg_bots(id) on delete cascade,
  spread_type text not null check (spread_type in ('bull_put_credit','bear_call_credit','bull_call_debit','bear_put_debit','long_call','long_put')),
  strategy_family text not null default 'credit_spread' check (strategy_family in ('credit_spread','debit_spread','long_option')),
  premium_type text not null default 'credit' check (premium_type in ('credit','debit')),
  min_dte integer not null check (min_dte > 0),
  max_dte integer not null check (max_dte >= min_dte),
  short_delta_target numeric(6,4) not null check (short_delta_target > 0 and short_delta_target < 1),
  target_width numeric(12,2) not null check (target_width >= 0),
  minimum_credit numeric(12,2) not null check (minimum_credit > 0),
  target_premium numeric(12,2) check (target_premium > 0),
  max_bid_ask_pct numeric(8,4) not null default 15 check (max_bid_ask_pct > 0),
  contracts integer not null default 1 check (contracts > 0),
  max_risk numeric(18,2) not null check (max_risk > 0),
  profit_close_pct numeric(8,4) not null default 50 check (profit_close_pct > 0 and profit_close_pct < 100),
  loss_close_multiple numeric(8,4) not null default 2 check (loss_close_multiple > 0),
  exit_dte integer not null default 7 check (exit_dte >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.bg_bot_runs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('running','paused','completed','stopped','error')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  realized_pnl numeric(18,4) not null default 0,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.bg_trades (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.bg_bot_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  status text not null check (status in ('pending','open','closing','closed','cancelled','error')),
  side text not null check (side in ('long','short')),
  quantity numeric(24,8) not null default 0,
  average_entry numeric(24,8),
  realized_pnl numeric(18,4) not null default 0,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bg_orders (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid references public.bg_trades(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_order_id text,
  client_order_id text not null unique,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  order_type text not null check (order_type in ('market','limit','stop','stop_limit','trailing_stop')),
  quantity numeric(24,8),
  notional numeric(18,2),
  limit_price numeric(24,8),
  stop_price numeric(24,8),
  status text not null default 'created',
  raw_response jsonb,
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bg_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.bg_orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  quantity numeric(24,8) not null,
  price numeric(24,8) not null,
  fee numeric(18,6) not null default 0,
  filled_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bg_bot_events (
  id bigint generated always as identity primary key,
  bot_id uuid references public.bg_bots(id) on delete cascade,
  run_id uuid references public.bg_bot_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  severity text not null default 'info' check (severity in ('info','warning','error')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bg_bot_status (
  bot_id uuid primary key references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id text not null,
  reason_code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create table if not exists public.bg_backtests (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('running','completed','failed','signal_only')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_seconds bigint not null check (duration_seconds >= 0),
  initial_capital numeric(18,2) not null,
  ending_capital numeric(18,2),
  net_pnl numeric(18,4),
  return_pct numeric(12,6),
  max_drawdown_pct numeric(12,6),
  trade_count integer not null default 0,
  win_count integer not null default 0,
  loss_count integer not null default 0,
  signal_count integer not null default 0,
  estimated_pnl numeric(18,4),
  estimated_return_pct numeric(12,6),
  estimate_low_pct numeric(12,6),
  estimate_high_pct numeric(12,6),
  estimate_confidence text,
  data_feed text not null default 'iex',
  market_regime text,
  market_return_pct numeric(12,6),
  volatility_label text,
  daily_regimes jsonb not null default '[]'::jsonb,
  methodology text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.bg_backtest_trades (
  id uuid primary key default gen_random_uuid(),
  backtest_id uuid not null references public.bg_backtests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_at timestamptz not null,
  exit_at timestamptz,
  entry_price numeric(24,8) not null,
  exit_price numeric(24,8),
  quantity numeric(24,8) not null,
  pnl numeric(18,4),
  exit_reason text,
  created_at timestamptz not null default now()
);

create index if not exists bg_bots_user_status_idx on public.bg_bots(user_id, status);
create index if not exists bg_runs_bot_started_idx on public.bg_bot_runs(bot_id, started_at desc);
create index if not exists bg_events_user_created_idx on public.bg_bot_events(user_id, created_at desc);
create index if not exists bg_status_user_checked_idx on public.bg_bot_status(user_id, checked_at desc);

alter table public.bg_profiles enable row level security;
alter table public.bg_broker_connections enable row level security;
alter table public.bg_broker_credentials enable row level security;
alter table public.bg_bots enable row level security;
alter table public.bg_averaging_steps enable row level security;
alter table public.bg_option_spreads enable row level security;
alter table public.bg_bot_runs enable row level security;
alter table public.bg_trades enable row level security;
alter table public.bg_orders enable row level security;
alter table public.bg_fills enable row level security;
alter table public.bg_bot_events enable row level security;
alter table public.bg_bot_status enable row level security;
alter table public.bg_backtests enable row level security;
alter table public.bg_backtest_trades enable row level security;

create policy "profiles own rows" on public.bg_profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "connections own rows read" on public.bg_broker_connections for select using (auth.uid() = user_id);
create policy "bots own rows" on public.bg_bots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "steps through owned bots" on public.bg_averaging_steps for all using (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid())) with check (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid()));
create policy "option spreads through owned bots" on public.bg_option_spreads for all using (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid())) with check (exists (select 1 from public.bg_bots b where b.id = bot_id and b.user_id = auth.uid()));
create policy "runs own rows read" on public.bg_bot_runs for select using (auth.uid() = user_id);
create policy "trades own rows read" on public.bg_trades for select using (auth.uid() = user_id);
create policy "orders own rows read" on public.bg_orders for select using (auth.uid() = user_id);
create policy "fills own rows read" on public.bg_fills for select using (auth.uid() = user_id);
create policy "events own rows read" on public.bg_bot_events for select using (auth.uid() = user_id);
create policy "status own rows read" on public.bg_bot_status for select using (auth.uid() = user_id);
create policy "backtests own rows read" on public.bg_backtests for select using (auth.uid() = user_id);
create policy "backtest trades own rows read" on public.bg_backtest_trades for select using (auth.uid() = user_id);

create or replace function public.bg_handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.bg_profiles(user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists bg_on_auth_user_created on auth.users;
create trigger bg_on_auth_user_created after insert on auth.users for each row execute procedure public.bg_handle_new_user();

create or replace function public.bg_assign_unique_bot_name() returns trigger language plpgsql security definer set search_path = '' as $$
declare base_name text; candidate text; suffix integer := 2;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  base_name := trim(new.name); candidate := base_name;
  while exists (select 1 from public.bg_bots where user_id = new.user_id and lower(name) = lower(candidate)) loop
    candidate := base_name || ' ' || suffix; suffix := suffix + 1;
  end loop;
  new.name := candidate; return new;
end;
$$;
drop trigger if exists bg_unique_bot_name on public.bg_bots;
create trigger bg_unique_bot_name before insert on public.bg_bots for each row execute procedure public.bg_assign_unique_bot_name();
