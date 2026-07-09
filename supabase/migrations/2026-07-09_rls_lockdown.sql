-- =============================================================
-- 2026-07-09 — RLS lockdown: requests + settings
-- Pre-req: Edge Functions deployed on service-role client.
-- =============================================================

-- ---- Password-gated admin RPCs for requests ---------------------------------
create or replace function get_admin_requests(p_password text)
returns setof requests
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
  return query select * from requests order by created_at desc;
end;
$$;

create or replace function update_admin_request(
  p_password text,
  p_id uuid,
  p_status text default null,
  p_admin_notes text default null,
  p_sent_at timestamptz default null,
  p_paid_at timestamptz default null
)
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
  update requests set
    status      = coalesce(p_status, status),
    admin_notes = coalesce(p_admin_notes, admin_notes),
    sent_at     = coalesce(p_sent_at, sent_at),
    paid_at     = coalesce(p_paid_at, paid_at)
  where id = p_id;
end;
$$;

-- ---- Rotate the leaked admin password ----------------------------------------
update settings set value = '<ROTATED — set via set_admin_setting>' where key = 'admin_password';

-- ---- Drop the open policies ---------------------------------------------------
-- settings: NO anon access at all (RPCs only)
drop policy if exists "Anyone can read settings" on settings;
drop policy if exists "Anyone can update settings" on settings;
drop policy if exists "Anyone can insert settings" on settings;

-- requests: keep INSERT (customer forms), drop read/update
drop policy if exists "Anyone can read requests" on requests;
drop policy if exists "Anyone can update requests" on requests;
