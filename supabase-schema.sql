-- =============================================
-- צייד טיסות — Supabase Schema
-- =============================================

-- טבלת בקשות
create table if not exists requests (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),

  -- סוג בקשה
  type text not null check (type in ('beat', 'research')),

  -- פרטי לקוח
  name text not null,
  whatsapp text not null,
  email text,

  -- פרטי טיסה
  from_iata text not null,
  to_iata text not null,
  depart_date date not null,
  return_date date,
  is_one_way boolean default false,
  adults int default 1,
  children int default 0,

  -- העדפות
  budget_usd int,
  preference text check (preference in ('cheapest', 'direct', 'balanced')),
  flexible_dates boolean default false,
  luggage text,
  preferred_airline text,
  notes text,

  -- מחיר לקוח (מסלול "הכה את המחיר")
  customer_price_usd int,
  customer_price_source text,
  customer_price_url text,

  -- תוצאות AI
  ai_response jsonb,
  cheapest_found int,

  -- סטטוס
  status text default 'pending' check (status in ('pending', 'searching', 'found', 'sent_price', 'awaiting_payment', 'paid', 'sent', 'not_found', 'failed')),

  -- תשלום
  amount_paid int,
  payment_id text,
  paid_at timestamptz,

  -- ניהול
  admin_notes text,
  sent_at timestamptz
);

-- טבלת הגדרות
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- הגדרות ברירת מחדל
insert into settings (key, value) values
  ('serpapi_key', ''),
  ('skyfare_key', ''),
  ('claude_key', ''),
  ('green_instance', ''),
  ('green_token', ''),
  ('admin_whatsapp', ''),
  ('sumit_company_id', ''),
  ('sumit_api_key', ''),
  ('admin_password', 'hunter2025'),
  ('service_price', '249'),
  ('test_mode', 'false'),
  ('admin_approval', 'true'),
  ('webhook_search', 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/search-flights'),
  ('webhook_payment', 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/handle-payment'),
  ('webhook_reply', 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/handle-reply')
on conflict (key) do nothing;

-- RLS - Row Level Security
alter table requests enable row level security;
alter table settings enable row level security;

-- כולם יכולים להוסיף בקשה (טפסי לקוח)
create policy "Anyone can insert requests" on requests for insert with check (true);
-- כולם יכולים לקרוא (הפרונט צריך לקרוא)
create policy "Anyone can read requests" on requests for select using (true);
-- כולם יכולים לעדכן (Make.com + admin)
create policy "Anyone can update requests" on requests for update using (true);

-- הגדרות - קריאה ועדכון לכולם (נגיש מהפרונט admin)
create policy "Anyone can read settings" on settings for select using (true);
create policy "Anyone can update settings" on settings for update using (true);
create policy "Anyone can insert settings" on settings for insert with check (true);

-- אינדקסים
create index if not exists idx_requests_status on requests(status);
create index if not exists idx_requests_whatsapp on requests(whatsapp);
create index if not exists idx_requests_created on requests(created_at desc);
