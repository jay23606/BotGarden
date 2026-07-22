alter table public.bg_orders
  add column if not exists bot_id uuid references public.bg_bots(id) on delete set null;

create index if not exists bg_orders_bot_created_idx on public.bg_orders(bot_id, created_at desc);

create table if not exists public.bg_fill_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id text not null,
  broker_order_id text not null,
  bot_id uuid references public.bg_bots(id) on delete set null,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  quantity numeric(24,8) not null,
  price numeric(24,8) not null,
  transaction_time timestamptz not null,
  raw_activity jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, activity_id)
);

create index if not exists bg_fill_ledger_user_time_idx on public.bg_fill_ledger(user_id, transaction_time);
create index if not exists bg_fill_ledger_bot_time_idx on public.bg_fill_ledger(bot_id, transaction_time);
alter table public.bg_fill_ledger enable row level security;
drop policy if exists "fill ledger own rows read" on public.bg_fill_ledger;
create policy "fill ledger own rows read" on public.bg_fill_ledger for select using (auth.uid() = user_id);
