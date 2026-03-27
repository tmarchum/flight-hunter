-- פונקציה שמחזירה את כל ההגדרות כאובייקט JSON אחד
-- זה מאפשר ל-Make.com לקרוא את כל המפתחות בקריאה אחת
CREATE OR REPLACE FUNCTION get_settings_json()
RETURNS json AS $$
  SELECT json_object_agg(key, value) FROM settings;
$$ LANGUAGE sql SECURITY DEFINER;
