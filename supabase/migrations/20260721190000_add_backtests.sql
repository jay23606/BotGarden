create table if not exists public.bg_backtests (
  id uuid primary key default gen_random_uuid(), bot_id uuid not null references public.bg_bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, status text not null check (status in ('running','completed','failed','signal_only')),
  start_at timestamptz not null, end_at timestamptz not null, duration_seconds bigint not null check (duration_seconds >= 0),
  initial_capital numeric(18,2) not null, ending_capital numeric(18,2), net_pnl numeric(18,4), return_pct numeric(12,6),
  max_drawdown_pct numeric(12,6), trade_count integer not null default 0, win_count integer not null default 0,
  loss_count integer not null default 0, signal_count integer not null default 0, data_feed text not null default 'iex',
  methodology text, error_message text, created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.bg_backtest_trades (
  id uuid primary key default gen_random_uuid(), backtest_id uuid not null references public.bg_backtests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, entry_at timestamptz not null, exit_at timestamptz,
  entry_price numeric(24,8) not null, exit_price numeric(24,8), quantity numeric(24,8) not null,
  pnl numeric(18,4), exit_reason text, created_at timestamptz not null default now()
);
create index if not exists bg_backtests_bot_created_idx on public.bg_backtests(bot_id, created_at desc);
alter table public.bg_backtests enable row level security;
alter table public.bg_backtest_trades enable row level security;
drop policy if exists "backtests own rows read" on public.bg_backtests;
create policy "backtests own rows read" on public.bg_backtests for select using (auth.uid() = user_id);
drop policy if exists "backtest trades own rows read" on public.bg_backtest_trades;
create policy "backtest trades own rows read" on public.bg_backtest_trades for select using (auth.uid() = user_id);
