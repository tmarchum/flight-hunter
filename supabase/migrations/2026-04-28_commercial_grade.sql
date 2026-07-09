-- =============================================================
-- 2026-04-28 — Commercial-grade migrations for צייד טיסות
-- Safe to apply: additive changes only (does not break the existing SPA).
-- =============================================================

-- ---- Recovery: clean up stuck "searching" requests --------------------------
-- (Old crashes left rows in `searching` forever — mark them failed.)
update requests
set    status = 'failed',
       admin_notes = coalesce(admin_notes, '') || ' [auto-recovered: stuck in searching]'
where  status = 'searching'
  and  created_at < now() - interval '5 minutes';

-- ---- Recovery: legacy `sent_price` rows are equivalent to `awaiting_payment` ----
update requests
set    status = 'awaiting_payment'
where  status = 'sent_price';

-- ---- Add updated_at column + trigger ----------------------------------------
alter table requests add column if not exists updated_at timestamptz default now();

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists requests_updated_at on requests;
create trigger requests_updated_at
  before update on requests
  for each row execute function set_updated_at();

drop trigger if exists settings_updated_at on settings;
create trigger settings_updated_at
  before update on settings
  for each row execute function set_updated_at();

-- ---- Indexes ----------------------------------------------------------------
create index if not exists idx_requests_status_created on requests(status, created_at desc);
create index if not exists idx_requests_whatsapp_status on requests(whatsapp, status);
create index if not exists idx_requests_id_prefix on requests((substring(id::text, 1, 8)));

-- ---- Public settings RPC (safe subset, callable by anon) --------------------
-- Returns ONLY non-secret config the SPA actually needs. Use this for the
-- public site instead of `select * from settings`.
create or replace function get_public_settings()
returns json
language sql
security definer
as $$
  select json_object_agg(key, value)
  from settings
  where key in (
    'service_price', 'vip_price',
    'admin_approval', 'test_mode',
    'site_url',
    'webhook_search', 'webhook_payment', 'webhook_reply'
  );
$$;

-- ---- Admin settings RPC (password-gated) ------------------------------------
-- Admin panel should call this with the typed password instead of selecting *.
create or replace function get_admin_settings(p_password text)
returns json
language plpgsql
security definer
as $$
declare
  v_pw text;
begin
  select value into v_pw from settings where key = 'admin_password';
  if v_pw is null or v_pw = '' or p_password <> v_pw then
    raise exception 'unauthorized';
  end if;
  return (select json_object_agg(key, value) from settings);
end;
$$;

-- ---- Admin update RPC (password-gated) --------------------------------------
create or replace function set_admin_setting(p_password text, p_key text, p_value text)
returns void
language plpgsql
security definer
as $$
declare
  v_pw text;
begin
  select value into v_pw from settings where key = 'admin_password';
  if v_pw is null or v_pw = '' or p_password <> v_pw then
    raise exception 'unauthorized';
  end if;
  insert into settings(key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- =============================================================
-- SECURITY (apply manually AFTER updating SPA to use the RPCs above):
--
--   drop policy if exists "Anyone can read settings" on settings;
--   drop policy if exists "Anyone can update settings" on settings;
--   drop policy if exists "Anyone can insert settings" on settings;
--
-- This locks the settings table; only the Edge Functions (via SECURITY DEFINER
-- RPCs) and the admin SPA (via password-gated RPCs) can read/write.
-- =============================================================
