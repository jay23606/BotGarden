create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$ begin perform cron.unschedule('botgarden-paper-runner'); exception when others then null; end $$;

select cron.schedule(
  'botgarden-paper-runner',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://zbtgonklxweikgukzukg.supabase.co/functions/v1/paper-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-runner-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where lower(name) in ('bg_runner_secret', 'botgarden_runner_secret', 'runner_secret') limit 1),
        (select decrypted_secret from vault.decrypted_secrets where lower(name) like '%runner%' limit 1),
        ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $job$
);
