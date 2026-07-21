alter table public.bg_backtests add column if not exists estimated_pnl numeric(18,4);
alter table public.bg_backtests add column if not exists estimated_return_pct numeric(12,6);
alter table public.bg_backtests add column if not exists estimate_low_pct numeric(12,6);
alter table public.bg_backtests add column if not exists estimate_high_pct numeric(12,6);
alter table public.bg_backtests add column if not exists estimate_confidence text;
