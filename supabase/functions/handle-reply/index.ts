// =============================================================
// handle-reply — Green API webhook for inbound WhatsApp messages.
//
// Behaviour:
//   - If the sender doesn't match any request in our DB, ignore
//     silently (no admin notification). Filters out spam, telemarketers,
//     and personal contacts.
//   - If the sender HAS a request in `awaiting_payment` and replies "כן",
//     send a stub message + flag admin (they may need to help).
//   - If the sender has any other request in DB, forward the message
//     to admin with request context.
// =============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://stncskqjrmecjckxldvi.supabase.co";
const SB_KEY = "sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I";

const AIRPORT_NAMES: Record<string, string> = {
  TLV:'תל אביב',ETH:'אילת',LHR:'לונדון',LGW:'לונדון',CDG:'פריז',ORY:'פריז',
  FCO:'רומא',MXP:'מילאנו',VCE:'ונציה',BCN:'ברצלונה',MAD:'מדריד',
  ATH:'אתונה',SKG:'סלוניקי',HER:'כרתים',RHO:'רודוס',JMK:'מיקונוס',JTR:'סנטוריני',
  BER:'ברלין',MUC:'מינכן',FRA:'פרנקפורט',AMS:'אמסטרדם',VIE:'וינה',ZRH:'ציריך',
  PRG:'פראג',BUD:'בודפשט',WAW:'ורשה',IST:'איסטנבול',AYT:'אנטליה',
  JFK:'ניו יורק',LAX:'לוס אנג\'לס',MIA:'מיאמי',BKK:'בנגקוק',DXB:'דובאי',AMM:'עמאן',
  LCA:'לרנקה',SSH:'שארם א-שייח',HRG:'הורגדה',
};
const heCity = (iata: string) => AIRPORT_NAMES[iata] ? `${AIRPORT_NAMES[iata]} (${iata})` : iata;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonResp = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

async function sendWhatsApp(settings: any, phoneLocal: string, message: string) {
  if (!settings.green_instance || !settings.green_token) return;
  const intl = phoneLocal.startsWith("0") ? "972" + phoneLocal.slice(1) : phoneLocal;
  try {
    await fetch(
      `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: `${intl}@c.us`, message }),
      }
    );
  } catch (e) {
    console.error("sendWhatsApp error:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = createClient(SB_URL, SB_KEY);
    const body = await req.json().catch(() => ({}));

    // Skip outgoing-message webhooks (our own messages echoing back)
    const wt = body.typeWebhook || "";
    if (wt === "outgoingMessageStatus" ||
        wt === "outgoingAPIMessageReceived" ||
        wt === "outgoingMessageReceived") {
      return jsonResp({ success: true, action: "ignored", reason: "outgoing" });
    }

    // Skip group messages — the business number is a member of personal
    // WhatsApp groups too, and group chatter is not customer support.
    // Group chatIds end in "@g.us"; 1-on-1 chats end in "@c.us".
    const chatId = body.senderData?.chatId || "";
    if (chatId.endsWith("@g.us")) {
      return jsonResp({ success: true, action: "ignored", reason: "group message" });
    }

    const senderPhoneRaw =
      body.senderData?.sender?.replace("@c.us", "") || body.phone || body.from || "";
    const messageText = (
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text ||
      body.text || body.message || ""
    ).trim();

    if (!senderPhoneRaw) {
      return jsonResp({ success: true, action: "ignored", reason: "no sender" });
    }

    // Normalize sender phone → local Israeli format "05XXXXXXXX"
    const phoneDigits = senderPhoneRaw.replace(/[^0-9]/g, "");
    const localPhone = phoneDigits.startsWith("972")
      ? "0" + phoneDigits.slice(3)
      : phoneDigits;

    // Load settings
    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};

    // Lookup request: most recent for this phone (any status).
    // The form historically stored whatever the customer typed, so the DB
    // holds mixed formats: "05XXXXXXXX", "+972XXXXXXXXX", "972XXXXXXXXX",
    // and even "5XXXXXXXX" — match all variants.
    const bare = localPhone.replace(/^0/, ""); // "5XXXXXXXX"
    const variants = [localPhone, bare, `972${bare}`, `+972${bare}`];
    const { data: requests } = await sb
      .from("requests")
      .select("*")
      .in("whatsapp", variants)
      .order("created_at", { ascending: false })
      .limit(1);
    const request = requests?.[0];

    // ---- Sender NOT in DB → silently ignore (filters spam/random contacts) ----
    if (!request) {
      return jsonResp({ success: true, action: "ignored", reason: "no matching customer in DB" });
    }

    // ---- Sender is a customer ----
    const normalized = messageText.toLowerCase();
    const isYes = ["כן", "yes", "כ", "1", "👍"].includes(normalized);

    // "כן" on awaiting_payment → resend stub + notify admin
    if (isYes && request.status === "awaiting_payment") {
      await sendWhatsApp(settings, localPhone,
        `שלום ${request.name} 👋\n\n` +
        `קיבלת כבר קישור תשלום בהודעה קודמת. אם הקישור פג תוקף או לא מצליח, נציג ייצור איתך קשר.\n\n` +
        `📋 מספר בקשה: ${request.id}\n_צייד טיסות ✈️_`);
      if (settings.admin_whatsapp) {
        await sendWhatsApp(settings, settings.admin_whatsapp,
          `🔔 *לקוח שלח "כן" — אולי צריך עזרה עם תשלום*\n\n` +
          `👤 ${request.name} (${request.whatsapp})\n` +
          `📋 בקשה: ${request.id.slice(0, 8)} (${request.status})\n` +
          `_צייד טיסות ✈️_`);
      }
      return jsonResp({ success: true, action: "yes_handled", request_id: request.id });
    }

    // Only forward when the ball is in our court — customer is waiting on
    // us (admin approval, payment hangup, or search-in-progress). Skip once
    // they've already received results (paid/sent) or the request resolved
    // with no match (not_found/failed).
    const ACTIVE_STATUSES = ["pending", "searching", "found", "awaiting_payment"];
    if (!ACTIVE_STATUSES.includes(request.status)) {
      return jsonResp({ success: true, action: "ignored", reason: `customer status '${request.status}' — not active` });
    }

    // Forward to admin with context
    if (settings.admin_whatsapp && messageText) {
      const ctx = request.from_iata
        ? `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`
        : "";
      await sendWhatsApp(settings, settings.admin_whatsapp,
        `💬 *הודעה נכנסת מלקוח*\n\n` +
        `👤 ${request.name} (${senderPhoneRaw})\n` +
        `📋 בקשה: ${request.id.slice(0, 8)} (${request.status})\n` +
        ctx +
        `\n📥 *ההודעה:*\n${messageText.slice(0, 500)}\n\n_צייד טיסות ✈️_`);
    }

    return jsonResp({ success: true, action: "forwarded", request_id: request.id });
  } catch (err) {
    console.error("handle-reply error:", err);
    return jsonResp({ error: String(err) }, 500);
  }
});
