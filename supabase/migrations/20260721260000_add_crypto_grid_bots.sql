alter table public.bg_bots drop constraint if exists bg_bots_asset_class_check;
alter table public.bg_bots add constraint bg_bots_asset_class_check check (asset_class in ('equity','option','crypto'));
alter table public.bg_bots drop constraint if exists bg_bots_session_policy_check;
alter table public.bg_bots add constraint bg_bots_session_policy_check check (session_policy in ('regular','extended','continuous'));
create table if not exists public.bg_grid_configs (bot_id uuid primary key references public.bg_bots(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,lower_price numeric(20,8) not null,upper_price numeric(20,8) not null,grid_levels integer not null check (grid_levels between 3 and 50),order_amount numeric(18,2) not null check (order_amount > 0),spacing_mode text not null default 'arithmetic' check (spacing_mode in ('arithmetic','geometric')),recenter_enabled boolean not null default true,fee_bps numeric(8,3) not null default 25,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check (upper_price > lower_price));
alter table public.bg_grid_configs enable row level security;
create policy "grid configs own rows" on public.bg_grid_configs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
