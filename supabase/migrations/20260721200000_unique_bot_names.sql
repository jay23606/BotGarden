create or replace function public.bg_assign_unique_bot_name() returns trigger language plpgsql security definer set search_path = '' as $$
declare base_name text; candidate text; suffix integer := 2;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  base_name := trim(new.name); candidate := base_name;
  while exists (select 1 from public.bg_bots where user_id = new.user_id and lower(name) = lower(candidate)) loop
    candidate := base_name || ' ' || suffix; suffix := suffix + 1;
  end loop;
  new.name := candidate; return new;
end;
$$;
drop trigger if exists bg_unique_bot_name on public.bg_bots;
create trigger bg_unique_bot_name before insert on public.bg_bots for each row execute procedure public.bg_assign_unique_bot_name();
