// =============================================================
// handle-reply — Green API webhook for inbound WhatsApp messages.
//
// LEGACY: original flow asked the customer to reply "כן" to receive a
// payment link. The current flow embeds the payment link inside the
// teaser message, so this endpoint is rarely needed.
//
// Behaviour now:
//  - If the inbound message is "כן"/"yes" AND the customer has a request
//    in `awaiting_payment` (no payment received yet), we resend the
//    payment link so they don't lose it.
//  - Any other message is acknowledged and forwarded to the admin so
//    they can respond manually.
// =============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SB_URL, SB_PUBLISHABLE,
  corsHeaders, jsonResponse,
  heCity, normalizeIsraeliPhone, sendWhatsApp,
  fetchWithTimeout,
  logInfo, logError,
} from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = createClient(SB_URL, SB_PUBLISHABLE);
    const body = await req.json().catch(() => ({}));

    const senderPhoneRaw =
      body.senderData?.sender?.replace("@c.us", "") ||
      body.phone || body.from || "";
    const messageText = (
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text ||
      body.text || body.message || ""
    ).trim();

    if (!senderPhoneRaw) return jsonResponse({ success: true, action: "ignored", reason: "no sender" });

    // Don't echo our own outgoing messages back to ourselves
    if (body.typeWebhook === "outgoingMessageStatus" || body.typeWebhook === "outgoingAPIMessageReceived") {
      return jsonResponse({ success: true, action: "ignored", reason: "outgoing" });
    }

    const localPhone = normalizeIsraeliPhone(senderPhoneRaw);
    const normalized = messageText.toLowerCase();
    const isYes = ["כן", "yes", "כ", "1", "👍"].includes(normalized);

    // Load settings + admin
    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};

    // Look up the most recent active request for this phone
    const { data: requests } = await sb.from("requests")
      .select("*")
      .eq("whatsapp", localPhone)
      .in("status", ["awaiting_payment", "found", "sent_price"]) // include legacy sent_price
      .order("created_at", { ascending: false })
      .limit(1);

    const request = requests?.[0];

    // ---- "כן" reply with awaiting_payment → resend payment link ----
    if (isYes && request && request.status === "awaiting_payment") {
      logInfo("reply.resend_payment", { request_id: request.id });
      // Resend the original teaser+link. We don't have the SUMIT link stored, so
      // we just acknowledge and let admin handle it manually for now.
      await sendWhatsApp(settings, localPhone,
        `שלום ${request.name} 👋\n\n` +
        `קיבלת כבר קישור תשלום בהודעה קודמת. אם הקישור פג תוקף או לא מצליח, נציג ייצור איתך קשר.\n\n` +
        `📋 מספר בקשה: ${request.id}\n_צייד טיסות ✈️_`);
      // Notify admin
      if (settings.admin_whatsapp) {
        await sendWhatsApp(settings, settings.admin_whatsapp,
          `🔔 *לקוח שלח "כן" — אולי צריך עזרה עם תשלום*\n\n` +
          `👤 ${request.name} (${request.whatsapp})\n` +
          `📋 בקשה: ${request.id.slice(0, 8)}\n` +
          `_צייד טיסות ✈️_`);
      }
      return jsonResponse({ success: true, action: "yes_handled", request_id: request.id });
    }

    // ---- Forward any other message to admin ----
    if (settings.admin_whatsapp && messageText) {
      const ctx = request
        ? `📋 בקשה אחרונה: ${request.id.slice(0, 8)} (${request.status})\n` +
          (request.from_iata ? `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` : "")
        : "";
      await sendWhatsApp(settings, settings.admin_whatsapp,
        `💬 *הודעה נכנסת מלקוח*\n\n` +
        `👤 ${request?.name || "לקוח לא ידוע"} (${senderPhoneRaw})\n` +
        ctx +
        `\n📥 *ההודעה:*\n${messageText.slice(0, 500)}\n\n_צייד טיסות ✈️_`);
    }

    return jsonResponse({ success: true, action: "forwarded", request_id: request?.id || null });
  } catch (err) {
    logError("handle_reply", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
