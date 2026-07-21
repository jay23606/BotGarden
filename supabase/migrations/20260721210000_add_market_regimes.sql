alter table public.bg_backtests add column if not exists market_regime text;
alter table public.bg_backtests add column if not exists market_return_pct numeric(12,6);
alter table public.bg_backtests add column if not exists volatility_label text;
alter table public.bg_backtests add column if not exists daily_regimes jsonb not null default '[]'::jsonb;
