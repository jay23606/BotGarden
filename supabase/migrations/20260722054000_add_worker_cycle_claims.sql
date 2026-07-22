create table if not exists public.bg_worker_cycle_claims (
  bot_id uuid not null references public.bg_bots(id) on delete cascade,
  worker_mode text not null check (worker_mode in ('entry-runner','risk-monitor')),
  cycle_key text not null,
  claimed_at timestamptz not null default now(),
  primary key (bot_id, worker_mode, cycle_key)
);

alter table public.bg_worker_cycle_claims enable row level security;

create or replace function public.bg_claim_bot_cycle(p_bot_id uuid, p_worker_mode text, p_cycle_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bg_worker_cycle_claims(bot_id, worker_mode, cycle_key)
  values (p_bot_id, p_worker_mode, p_cycle_key)
  on conflict do nothing;
  return found;
end;
$$;

revoke all on function public.bg_claim_bot_cycle(uuid, text, text) from public, anon, authenticated;
grant execute on function public.bg_claim_bot_cycle(uuid, text, text) to service_role;

do $$ begin perform cron.unschedule('botgarden-cycle-claim-cleanup'); exception when others then null; end $$;
select cron.schedule(
  'botgarden-cycle-claim-cleanup',
  '41 4 * * *',
  $$delete from public.bg_worker_cycle_claims where claimed_at < now() - interval '2 days';$$
);
