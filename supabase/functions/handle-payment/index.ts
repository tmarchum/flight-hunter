// =============================================================
// handle-payment — SUMIT redirect + webhook → mark paid + send full details
// Idempotent: safe to call multiple times.
// =============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SB_URL, SB_PUBLISHABLE,
  corsHeaders, jsonResponse,
  heCity, tripLabel, sendWhatsApp,
  logInfo, logError,
} from "../_shared/utils.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = createClient(SB_URL, SB_PUBLISHABLE);
    const url = new URL(req.url);

    // ---- Parse SUMIT redirect (GET) or webhook (POST) ----
    let requestId = "";
    let paymentId = "";
    let amountPaid = 0;

    if (req.method === "GET") {
      requestId = url.searchParams.get("request_id") || "";
      paymentId = url.searchParams.get("PaymentId") || url.searchParams.get("payment_id") || "";
    } else {
      const body = await req.json().catch(() => ({}));
      requestId = body.request_id || body.CustomFields?.request_id || body.ExternalIdentifier ||
                  url.searchParams.get("request_id") || "";
      paymentId = body.PaymentId || body.Data?.PaymentId || body.payment_id || "";
      amountPaid = Number(body.Total || body.Data?.Total || body.amount || 0);
    }

    if (!requestId) return jsonResponse({ error: "missing request_id" }, 400);

    // ---- Load request + settings ----
    const { data: request, error: reqErr } = await sb
      .from("requests").select("*").eq("id", requestId).single();
    if (reqErr || !request) return jsonResponse({ error: "request not found" }, 404);

    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};
    const isVip = request.type === "vip";
    const expectedPrice = parseInt(isVip ? (settings.vip_price || "399") : (settings.service_price || "249"));
    if (!amountPaid) amountPaid = expectedPrice;

    // ---- Idempotency: if already in terminal "sent" state, return early ----
    if (request.status === "sent") {
      logInfo("payment.duplicate_ignored", { request_id: requestId, status: request.status });
      // Still redirect (so user lands on success page) but don't re-send WhatsApp
      if (req.method === "GET") {
        const siteUrl = settings.site_url || "https://tmarchum.github.io/flight-hunter";
        return new Response(null, {
          status: 302,
          headers: { Location: `${siteUrl}?page=payment-success&request_id=${requestId}` },
        });
      }
      return jsonResponse({ success: true, request_id: requestId, status: "sent", duplicate: true });
    }

    // ---- Mark paid (only if not already paid) ----
    if (request.status !== "paid") {
      await sb.from("requests").update({
        status: "paid",
        payment_id: paymentId || request.payment_id || null,
        amount_paid: amountPaid,
        paid_at: new Date().toISOString(),
      }).eq("id", requestId);
    } else if (!request.amount_paid && amountPaid) {
      // Backfill amount_paid if test mode left it null
      await sb.from("requests").update({ amount_paid: amountPaid }).eq("id", requestId);
    }

    // ---- Send full details via WhatsApp ----
    if (settings.green_instance && settings.green_token) {
      const aiResp = request.ai_response || {};
      const customerFull = aiResp.customer_full || "";

      let msg = `שלום ${request.name} 🎉\n\n✅ התשלום התקבל! תודה רבה!\n\n`;

      if (isVip) {
        msg += `👑 *שירות VIP*\n\n`;
        if (customerFull) msg += customerFull;
        msg += `\nסוכן אישי ייצור איתך קשר בהקדם עם כל הפרטים וההמלצות.\n`;
      } else {
        msg += `הנה *הפרטים המלאים* שלך:\n\n`;
        msg += `✈️ *${heCity(request.from_iata)} → ${heCity(request.to_iata)}*\n`;
        msg += `🔄 ${tripLabel(request)}\n`;
        msg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
        msg += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n`;
        if (customerFull) msg += customerFull;
        else msg += `\n⚠️ לא נמצאו פרטי טיסות. צור קשר לקבלת עזרה.\n`;
      }

      msg += `\n⚠️ *שים לב:*\n`;
      msg += `• המחירים נכונים לרגע החיפוש ועשויים להשתנות\n`;
      msg += `• אנחנו מאתרים טיסות — ההזמנה מתבצעת ישירות מול חברת התעופה או אתר ההזמנות\n`;
      msg += `• כבודה, בחירת מושב ותוספות נוספות עשויים להיות בתשלום נפרד\n`;
      msg += `\n💡 *טיפ:* הזמן מוקדם — המחירים עשויים להשתנות!\n\n`;
      msg += `שאלות? פשוט שלח הודעה 😊\n\n📋 מספר בקשה: ${requestId}\n`;
      msg += `_צייד טיסות ✈️ — תודה שבחרת בנו!_`;

      const sendRes = await sendWhatsApp(settings, request.whatsapp, msg);
      if (sendRes.ok) {
        await sb.from("requests").update({
          status: "sent",
          sent_at: new Date().toISOString(),
        }).eq("id", requestId);
      } else {
        logError("payment.whatsapp_send", sendRes.error, { request_id: requestId });
      }

      // Notify admin
      if (settings.admin_whatsapp) {
        const adminMsg =
          `💳 *תשלום התקבל!*\n\n` +
          `👤 ${request.name} (${request.whatsapp})\n` +
          (isVip
            ? `👑 VIP — בקשה: ${(request.notes || "").slice(0, 100)}\n`
            : `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`) +
          `💰 ₪${amountPaid}\n📋 בקשה: ${requestId.slice(0, 8)}\n\n` +
          `${sendRes.ok ? "✅ פרטי הטיסות נשלחו ללקוח." : "⚠️ שליחת ההודעה ללקוח נכשלה — בדוק ידנית."}\n` +
          `_צייד טיסות ✈️_`;
        await sendWhatsApp(settings, settings.admin_whatsapp, adminMsg);
      }
    }

    // ---- GET: redirect to SPA success page ----
    if (req.method === "GET") {
      const siteUrl = settings.site_url || "https://tmarchum.github.io/flight-hunter";
      return new Response(null, {
        status: 302,
        headers: { Location: `${siteUrl}?page=payment-success&request_id=${requestId}` },
      });
    }

    return jsonResponse({ success: true, request_id: requestId, status: "sent" });
  } catch (err) {
    logError("handle_payment", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
