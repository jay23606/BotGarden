alter table public.bg_bots alter column status set default 'active';
update public.bg_bots set status = 'active', updated_at = now() where status = 'draft';
