alter table public.bg_backtests
  add column if not exists execution_model_version integer not null default 1 check (execution_model_version >= 1);

