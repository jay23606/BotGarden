alter table public.bg_user_controls
  add column if not exists max_gross_exposure_pct numeric(6,2) not null default 75 check (max_gross_exposure_pct between 1 and 200),
  add column if not exists max_symbol_exposure_pct numeric(6,2) not null default 20 check (max_symbol_exposure_pct between 1 and 100),
  add column if not exists max_daily_loss_pct numeric(6,2) not null default 3 check (max_daily_loss_pct between 0.1 and 50);

