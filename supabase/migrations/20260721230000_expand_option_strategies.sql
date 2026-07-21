alter table public.bg_bots drop constraint if exists bg_bots_bot_type_check;
alter table public.bg_bots add constraint bg_bots_bot_type_check
  check (bot_type in ('dca','grid','signal','credit_spread','option_strategy'));

alter table public.bg_option_spreads add column if not exists strategy_family text not null default 'credit_spread';
alter table public.bg_option_spreads add column if not exists premium_type text not null default 'credit';
alter table public.bg_option_spreads add column if not exists target_premium numeric(12,2);
update public.bg_option_spreads set target_premium = minimum_credit where target_premium is null;

alter table public.bg_option_spreads drop constraint if exists bg_option_spreads_spread_type_check;
alter table public.bg_option_spreads drop constraint if exists bg_option_spreads_target_width_check;
alter table public.bg_option_spreads drop constraint if exists bg_option_spreads_strategy_family_check;
alter table public.bg_option_spreads drop constraint if exists bg_option_spreads_premium_type_check;
alter table public.bg_option_spreads drop constraint if exists bg_option_spreads_target_premium_check;
alter table public.bg_option_spreads add constraint bg_option_spreads_spread_type_check
  check (spread_type in ('bull_put_credit','bear_call_credit','bull_call_debit','bear_put_debit','long_call','long_put'));
alter table public.bg_option_spreads add constraint bg_option_spreads_target_width_check check (target_width >= 0);
alter table public.bg_option_spreads add constraint bg_option_spreads_strategy_family_check
  check (strategy_family in ('credit_spread','debit_spread','long_option'));
alter table public.bg_option_spreads add constraint bg_option_spreads_premium_type_check check (premium_type in ('credit','debit'));
alter table public.bg_option_spreads add constraint bg_option_spreads_target_premium_check check (target_premium > 0);
