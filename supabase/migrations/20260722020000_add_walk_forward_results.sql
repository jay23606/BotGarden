alter table public.bg_backtests
  add column if not exists walk_forward jsonb not null default '{}'::jsonb;
