alter table public.bg_bots drop constraint if exists bg_bots_status_check;
alter table public.bg_bots add constraint bg_bots_status_check check (status in ('draft','active','paused','stopped','archived','error'));
