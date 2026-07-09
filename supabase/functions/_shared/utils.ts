// =============================================================
// Shared utilities for צייד טיסות Edge Functions
// =============================================================

// ---- Supabase / CORS ---------------------------------------------------------

export const SB_URL =
  Deno.env.get("SB_URL") ?? "https://stncskqjrmecjckxldvi.supabase.co";
// Publishable key is ok to embed — RLS + SECURITY DEFINER RPCs gate access.
export const SB_PUBLISHABLE =
  Deno.env.get("SB_PUBLISHABLE_KEY") ?? "sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I";
// Optional service-role key (set via Supabase secrets) — bypasses RLS for trusted server work.
export const SB_SERVICE = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

export const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });

// ---- Airport names (Hebrew) --------------------------------------------------

export const AIRPORT_NAMES: Record<string, string> = {
  // Israel
  TLV: "תל אביב", ETH: "אילת", VDA: "אילת רמון",
  // UK / Ireland
  LHR: "לונדון", LGW: "לונדון", STN: "לונדון", LTN: "לונדון", LCY: "לונדון",
  MAN: "מנצ'סטר", EDI: "אדינבורו", DUB: "דבלין",
  // France / Belgium / Netherlands
  CDG: "פריז", ORY: "פריז", BVA: "פריז בובה", NCE: "ניס", LYS: "ליון", MRS: "מרסיי",
  AMS: "אמסטרדם", BRU: "בריסל", CRL: "בריסל שרלרואה",
  // Italy
  FCO: "רומא", CIA: "רומא צ'יאמפינו", MXP: "מילאנו", LIN: "מילאנו לינאטה",
  BGY: "מילאנו ברגמו", VCE: "ונציה", NAP: "נאפולי", BLQ: "בולוניה", FLR: "פירנצה",
  CTA: "קטניה", PMO: "פלרמו", BRI: "בארי",
  // Spain / Portugal
  BCN: "ברצלונה", MAD: "מדריד", AGP: "מלגה", VLC: "ולנסיה", IBZ: "איביזה",
  PMI: "מיורקה", LIS: "ליסבון", OPO: "פורטו",
  // Greece / Cyprus / Turkey / Egypt
  ATH: "אתונה", SKG: "סלוניקי", HER: "כרתים", CHQ: "חניה", RHO: "רודוס",
  JMK: "מיקונוס", JTR: "סנטוריני", CFU: "קורפו", ZTH: "זקינתוס", KGS: "קוס",
  LCA: "לרנקה", PFO: "פאפוס", IST: "איסטנבול", SAW: "איסטנבול סבחא", AYT: "אנטליה",
  ESB: "אנקרה", ADB: "איזמיר", DLM: "דאלמן", BJV: "בודרום",
  SSH: "שארם א-שייח", HRG: "הורגדה", CAI: "קהיר",
  // Germany / Austria / Switzerland
  BER: "ברלין", MUC: "מינכן", FRA: "פרנקפורט", DUS: "דיסלדורף", HAM: "המבורג",
  CGN: "קלן", STR: "שטוטגרט", VIE: "וינה", ZRH: "ציריך", GVA: "ז'נבה", BSL: "באזל",
  // Eastern Europe
  PRG: "פראג", BUD: "בודפשט", WAW: "ורשה", KRK: "קרקוב", GDN: "גדנסק",
  SOF: "סופיה", OTP: "בוקרשט", BEG: "בלגרד", ZAG: "זאגרב", LJU: "לובליאנה",
  TLL: "טלין", RIX: "ריגה", VNO: "וילנה", KIV: "קישינב",
  // Scandinavia
  CPH: "קופנהגן", OSL: "אוסלו", ARN: "סטוקהולם", GOT: "גטבורג", HEL: "הלסינקי", KEF: "ריקיאוויק",
  // Americas
  JFK: "ניו יורק", EWR: "ניו יורק נוארק", LGA: "ניו יורק לגווארדיה",
  LAX: "לוס אנג'לס", SFO: "סן פרנסיסקו", MIA: "מיאמי", FLL: "פורט לודרדייל",
  ORD: "שיקגו", BOS: "בוסטון", IAD: "וושינגטון", ATL: "אטלנטה", MCO: "אורלנדו",
  LAS: "לאס וגאס", SEA: "סיאטל", DFW: "דאלאס", IAH: "יוסטון", PHL: "פילדלפיה",
  YYZ: "טורונטו", YUL: "מונטריאול", YVR: "ונקובר",
  CUN: "קנקון", MEX: "מקסיקו סיטי", GRU: "סאו פאולו", EZE: "בואנוס איירס",
  // Middle East / Asia
  DXB: "דובאי", AUH: "אבו דאבי", DOH: "דוחא", AMM: "עמאן", BAH: "בחריין",
  RUH: "ריאד", JED: "ג'דה", KWI: "כווית", MCT: "מסקט",
  DEL: "ניו דלהי", BOM: "מומבאי", BLR: "בנגלור",
  BKK: "בנגקוק", DMK: "בנגקוק דון מואנג", HKT: "פוקט", USM: "קוסמוי", CNX: "צ'יאנג מאי",
  KUL: "קואלה לומפור", SIN: "סינגפור", CGK: "ג'קרטה", DPS: "באלי",
  HKG: "הונג קונג", PEK: "בייג'ינג", PVG: "שנגחאי", NRT: "טוקיו", HND: "טוקיו הנדה",
  ICN: "סיאול", KIX: "אוסקה", TPE: "טייפה", MNL: "מנילה",
  // Africa
  JNB: "יוהנסבורג", CPT: "קייפטאון", CMN: "קזבלנקה", RAK: "מרקש", TUN: "תוניס", NBO: "ניירובי",
  // Oceania
  SYD: "סידני", MEL: "מלבורן",
};

export const heCity = (iata: string): string =>
  AIRPORT_NAMES[iata] ? `${AIRPORT_NAMES[iata]} (${iata})` : iata;

export const tripLabel = (r: { is_one_way?: boolean }): string =>
  r.is_one_way ? "הלוך בלבד" : "הלוך ושוב";

// ---- Phone normalization (Israel-first, tolerant of int'l input) ------------

/**
 * Normalize a phone string into its canonical 9-or-10-digit Israeli format
 * starting with leading 0 (e.g. "0505180180").
 * Accepts: "0505180180", "+972505180180", "972 50-518-0180", "(05) 0518-0180".
 */
export function normalizeIsraeliPhone(input: string): string {
  if (!input) return "";
  // Strip everything except digits and leading +
  const digitsOnly = input.replace(/[^\d+]/g, "");
  let digits = digitsOnly.replace(/^\+/, "");
  // 972 country code → 0
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  // Pure digits with no leading 0 but length 9 → assume Israeli mobile
  if (!digits.startsWith("0") && digits.length === 9) digits = "0" + digits;
  return digits;
}

/** Convert local Israeli phone to WhatsApp chatId ("972XXXXXXXXX@c.us"). */
export function toChatId(phone: string): string {
  const local = normalizeIsraeliPhone(phone);
  const intl = local.startsWith("0") ? "972" + local.slice(1) : local;
  return `${intl}@c.us`;
}

// ---- HTTP helpers ------------------------------------------------------------

/** fetch with hard timeout. Default 10s — tune per call site. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Minimal exponential-backoff retry. Only retries network errors / 5xx / 429. */
export async function fetchRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<Response> {
  const retries = init.retries ?? 1;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, init);
      if (r.status >= 500 || r.status === 429) {
        if (i === retries) return r;
      } else {
        return r;
      }
    } catch (e) {
      lastErr = e;
      if (i === retries) throw e;
    }
    // backoff: 400ms, 800ms, ...
    await new Promise((res) => setTimeout(res, 400 * Math.pow(2, i)));
  }
  throw lastErr ?? new Error("fetchRetry: exhausted");
}

// ---- Send WhatsApp via Green API --------------------------------------------

export async function sendWhatsApp(
  settings: { green_instance?: string; green_token?: string },
  phone: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  if (!settings.green_instance || !settings.green_token) {
    return { ok: false, error: "green api not configured" };
  }
  try {
    const r = await fetchWithTimeout(
      `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: toChatId(phone), message }),
        timeoutMs: 8_000,
      }
    );
    if (!r.ok) return { ok: false, error: `green api status ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- Validation --------------------------------------------------------------

export const isValidIATA = (s: string): boolean => /^[A-Z]{3}$/.test(s || "");
export const isValidISODate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s));
export const isFutureOrTodayDate = (s: string): boolean => {
  if (!isValidISODate(s)) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return new Date(s).getTime() >= today.getTime();
};
export const isValidEmail = (s?: string): boolean =>
  !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// ---- Logging -----------------------------------------------------------------

export function logInfo(stage: string, data: unknown = {}) {
  console.log(JSON.stringify({ level: "info", stage, ...(data as object), ts: new Date().toISOString() }));
}
export function logError(stage: string, err: unknown, data: unknown = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      stage,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ...(data as object),
      ts: new Date().toISOString(),
    })
  );
}
