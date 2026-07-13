-- =============================================================
-- 2026-07-09 — Explore mode: "cheapest anywhere" from an origin
-- =============================================================

-- New request type
alter table requests drop constraint if exists requests_type_check;
alter table requests add constraint requests_type_check
  check (type in ('beat', 'research', 'vip', 'explore'));

-- Departure-time window (HH:MM strings, explore only)
alter table requests add column if not exists depart_time_from text;
alter table requests add column if not exists depart_time_to   text;
