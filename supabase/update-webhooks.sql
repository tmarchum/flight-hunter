-- Update webhook URLs to point to Supabase Edge Functions instead of Make.com
UPDATE settings SET value = 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/search-flights', updated_at = now() WHERE key = 'webhook_search';
UPDATE settings SET value = 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/handle-payment', updated_at = now() WHERE key = 'webhook_payment';
UPDATE settings SET value = 'https://stncskqjrmecjckxldvi.supabase.co/functions/v1/handle-reply', updated_at = now() WHERE key = 'webhook_reply';
