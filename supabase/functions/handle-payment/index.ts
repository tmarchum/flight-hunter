import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://stncskqjrmecjckxldvi.supabase.co";
const SB_KEY = "sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(SB_URL, SB_KEY);

    // SUMIT can send payment confirmation as POST body or as redirect with query params
    let requestId = "";
    let paymentId = "";
    let amountPaid = 0;

    const url = new URL(req.url);

    if (req.method === "GET") {
      // Redirect from SUMIT after successful payment
      requestId = url.searchParams.get("request_id") || "";
      paymentId = url.searchParams.get("PaymentId") || url.searchParams.get("payment_id") || "";
    } else {
      const body = await req.json();
      // SUMIT webhook POST payload
      requestId =
        body.request_id ||
        body.CustomFields?.request_id ||
        url.searchParams.get("request_id") ||
        "";
      paymentId =
        body.PaymentId ||
        body.Data?.PaymentId ||
        body.payment_id ||
        "";
      amountPaid =
        body.Total ||
        body.Data?.Total ||
        body.amount ||
        249;
    }

    if (!requestId) {
      return new Response(JSON.stringify({ error: "missing request_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load the request
    const { data: request, error: reqErr } = await sb
      .from("requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (reqErr || !request) {
      return new Response(JSON.stringify({ error: "request not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load settings
    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};
    const servicePrice = parseInt(settings.service_price || "249");
    if (!amountPaid) amountPaid = servicePrice;

    // Update DB with payment info (only if not already paid — test mode may have already set this)
    if (request.status !== "paid") {
      await sb
        .from("requests")
        .update({
          status: "paid",
          payment_id: paymentId || null,
          amount_paid: amountPaid,
          paid_at: new Date().toISOString(),
        })
        .eq("id", requestId);
    }

    // Send full flight details via WhatsApp
    if (settings.green_instance && settings.green_token) {
      const wa = request.whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
      const chatId = `972${wa}@c.us`;

      const aiResp = request.ai_response || {};
      const results = aiResp.results || [];
      const isBeat = request.type === "beat";

      let msg = `שלום ${request.name} 🎉\n\n`;
      msg += `✅ התשלום התקבל! תודה רבה!\n\n`;
      msg += `הנה *הפרטים המלאים* שלך:\n\n`;
      msg += `✈️ *${request.from_iata} → ${request.to_iata}*\n`;
      msg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
      msg += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n\n`;

      if (isBeat && results.length > 0) {
        const best = results[0];
        const saving = (request.customer_price_usd || 0) - (best.price_usd || 0);
        msg += `🏆 *הטיסה הזולה ביותר שמצאנו:*\n\n`;
        msg += `💰 *$${best.price_usd}*${saving > 0 ? ` (חסכת $${saving}!)` : ""}\n`;
        msg += `🛫 *${best.airline}*\n`;
        msg += `${best.stops === 0 ? "✅ טיסה ישירה" : `🔄 ${best.stops} עצירות`}\n`;
        msg += `⏱️ ${best.duration_minutes ? Math.floor(best.duration_minutes / 60) + ":" + String(best.duration_minutes % 60).padStart(2, "0") + " שעות" : ""}\n`;
        if (best.departure_time) msg += `🕐 יציאה: ${best.departure_time}\n`;
        if (best.arrival_time) msg += `🕐 נחיתה: ${best.arrival_time}\n`;
        // Show flight segments
        if (best.flights_detail && best.flights_detail.length > 0) {
          msg += `\n📋 *פרטי טיסה:*\n`;
          for (const seg of best.flights_detail) {
            msg += `  ✈️ ${seg.airline} ${seg.flight_number || ""}\n`;
            msg += `     ${seg.departure?.id || ""} ${seg.departure?.time || ""} → ${seg.arrival?.id || ""} ${seg.arrival?.time || ""}\n`;
          }
        }
        msg += `\n🔎 מקור: ${best.source}\n`;
        if (best.booking_url) {
          msg += `🔗 *קישור להזמנה:*\n${best.booking_url}\n`;
        }
        if (best.booking_token) {
          msg += `\n🔗 *הזמנה ב-Google Flights:*\nhttps://www.google.com/travel/flights/booking?token=${best.booking_token}\n`;
        }
      }

      if (results.length > (isBeat ? 1 : 0)) {
        msg += `\n📊 *${isBeat ? "אופציות נוספות" : "5 הדילים הכי טובים"}:*\n\n`;
        const startIdx = isBeat ? 1 : 0;
        for (let i = startIdx; i < Math.min(5, results.length); i++) {
          const r = results[i];
          msg += `*${i + 1}. $${r.price_usd}* — ${r.airline}`;
          msg += ` | ${r.stops === 0 ? "ישיר" : r.stops + " עצירות"}`;
          if (r.duration_minutes) msg += ` | ${Math.floor(r.duration_minutes / 60)}:${String(r.duration_minutes % 60).padStart(2, "0")}`;
          msg += ` | ${r.source}\n`;
          if (r.departure_time) msg += `   🕐 ${r.departure_time}\n`;
          if (r.booking_url) msg += `   🔗 ${r.booking_url}\n`;
          if (r.booking_token) msg += `   🔗 https://www.google.com/travel/flights/booking?token=${r.booking_token}\n`;
        }
      }

      msg += `\n💡 *טיפ:* הזמן מוקדם — המחירים עשויים להשתנות!\n\n`;
      msg += `שאלות? פשוט שלח הודעה 😊\n\n`;
      msg += `_צייד טיסות ✈️ — תודה שבחרת בנו!_`;

      try {
        await fetch(
          `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, message: msg }),
          }
        );

        // Update status to sent
        await sb
          .from("requests")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", requestId);
      } catch (e) {
        console.error("WhatsApp send error:", e);
      }
    }

    // If this was a GET redirect from SUMIT, redirect to a thank-you page
    if (req.method === "GET") {
      return new Response(
        `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>תשלום התקבל — צייד טיסות</title>
<style>
body{background:#0a0a0f;color:#f0f0f5;font-family:'Heebo',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:400px;padding:40px}
</style>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet">
</head>
<body>
<div class="box">
<div style="font-size:64px;margin-bottom:16px">🎉</div>
<h1 style="font-size:28px;font-weight:900;margin:0 0 12px">התשלום התקבל!</h1>
<p style="color:#6b7280;font-size:16px;margin:0 0 24px">הפרטים המלאים נשלחו אליך ב-WhatsApp.<br/>תודה שבחרת בצייד טיסות ✈️</p>
<a href="/" style="color:#f5a623;text-decoration:none;font-weight:700">חזור לדף הבית</a>
</div>
</body>
</html>`,
        {
          headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, request_id: requestId, status: "paid" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("handle-payment error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
