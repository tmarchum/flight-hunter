-- =============================================================
-- 2026-07-09 — Sweep cron: admin reminders + stuck-request recovery
-- =============================================================

-- Track when the admin was last reminded about a pending request
alter table requests add column if not exists reminded_at timestamptz;

-- Secret for the sweep endpoint (pg_cron includes it; blocks public spam)
insert into settings (key, value) values ('sweep_key', '<ROTATED — value lives only in settings table>')
on conflict (key) do update set value = excluded.value;

-- Enable extensions (idempotent)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-schedule cleanly
select cron.unschedule('flight-hunter-sweep')
where exists (select 1 from cron.job where jobname = 'flight-hunter-sweep');

select cron.schedule(
  'flight-hunter-sweep',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/search-flights?action=sweep&key=<ROTATED — value lives only in settings table>',
    timeout_milliseconds := 30000
  );
  $$
);
