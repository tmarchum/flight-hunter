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
    const body = await req.json();
    const requestId = body.id;

    if (!requestId) {
      return new Response(JSON.stringify({ error: "missing request id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load settings
    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};

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

    // Update status to searching
    await sb.from("requests").update({ status: "searching" }).eq("id", requestId);

    // ---------- Search flights from multiple sources ----------
    const results: any[] = [];

    // 1. SerpApi (Google Flights)
    if (settings.serpapi_key) {
      try {
        const departDate = request.depart_date;
        const returnDate = request.return_date;
        const params = new URLSearchParams({
          engine: "google_flights",
          departure_id: request.from_iata,
          arrival_id: request.to_iata,
          outbound_date: departDate,
          type: request.is_one_way ? "2" : "1",
          adults: String(request.adults),
          children: String(request.children || 0),
          currency: "USD",
          api_key: settings.serpapi_key,
        });
        if (returnDate && !request.is_one_way) {
          params.set("return_date", returnDate);
        }

        const serpResp = await fetch(`https://serpapi.com/search.json?${params}`);
        const serpData = await serpResp.json();

        // Extract best flights
        const bestFlights = serpData.best_flights || [];
        const otherFlights = serpData.other_flights || [];
        const allFlights = [...bestFlights, ...otherFlights];

        for (const flight of allFlights.slice(0, 5)) {
          results.push({
            source: "Google Flights",
            price_usd: flight.price,
            airline: flight.flights?.[0]?.airline || "Unknown",
            stops: flight.flights ? flight.flights.length - 1 : 0,
            duration_minutes: flight.total_duration,
            departure_time: flight.flights?.[0]?.departure_airport?.time || "",
            arrival_time: flight.flights?.[flight.flights?.length - 1]?.arrival_airport?.time || "",
            booking_token: flight.booking_token || null,
            raw: flight,
          });
        }
      } catch (e) {
        console.error("SerpApi error:", e);
      }
    }

    // 2. SkyFare API
    if (settings.skyfare_key) {
      try {
        const skyResp = await fetch("https://api.skyfare.io/v1/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.skyfare_key}`,
          },
          body: JSON.stringify({
            origin: request.from_iata,
            destination: request.to_iata,
            departure_date: request.depart_date,
            return_date: request.is_one_way ? null : request.return_date,
            adults: request.adults,
            children: request.children || 0,
            currency: "USD",
          }),
        });
        const skyData = await skyResp.json();
        const skyResults = skyData.results || skyData.flights || skyData.data || [];

        for (const flight of (Array.isArray(skyResults) ? skyResults : []).slice(0, 5)) {
          results.push({
            source: "SkyFare",
            price_usd: flight.price || flight.price_usd,
            airline: flight.airline || flight.carrier || "Unknown",
            stops: flight.stops ?? flight.num_stops ?? 0,
            duration_minutes: flight.duration || flight.duration_minutes || 0,
            departure_time: flight.departure_time || flight.departure || "",
            arrival_time: flight.arrival_time || flight.arrival || "",
            booking_url: flight.booking_url || flight.deep_link || null,
            raw: flight,
          });
        }
      } catch (e) {
        console.error("SkyFare error:", e);
      }
    }

    // Sort by price
    results.sort((a, b) => (a.price_usd || 9999) - (b.price_usd || 9999));

    // Find cheapest price
    const cheapest = results.length > 0 ? results[0].price_usd : null;

    // Build AI response
    const isBeat = request.type === "beat";
    let summary = "";
    let status = "found";

    if (results.length === 0) {
      status = "not_found";
      summary = "לא נמצאו תוצאות עבור החיפוש הזה. נסה תאריכים אחרים או יעד אחר.";
    } else if (isBeat) {
      const customerPrice = request.customer_price_usd || 0;
      if (cheapest && cheapest < customerPrice) {
        const saving = customerPrice - cheapest;
        summary = `🎉 מצאנו טיסה זולה יותר!\n\n`;
        summary += `המחיר שלך: $${customerPrice}\n`;
        summary += `המחיר שמצאנו: $${cheapest}\n`;
        summary += `חיסכון: $${saving}\n\n`;
        summary += `✈️ ${results[0].airline} | ${results[0].stops === 0 ? "ישיר" : results[0].stops + " עצירות"}\n`;
        summary += `🔎 מקור: ${results[0].source}`;
      } else {
        summary = `לא מצאנו מחיר זול יותר מ-$${customerPrice}.\n`;
        summary += `המחיר הזול ביותר שמצאנו: $${cheapest}\n`;
        summary += `ייתכן שהמחיר שמצאת הוא כבר הדיל הכי טוב!`;
        status = "not_found";
      }
    } else {
      // Research report
      summary = `📊 דוח מחקר טיסות\n`;
      summary += `${request.from_iata} ← ${request.to_iata}\n`;
      summary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      summary += `🏆 5 הדילים הכי טובים:\n\n`;
      for (let i = 0; i < Math.min(5, results.length); i++) {
        const r = results[i];
        summary += `${i + 1}. $${r.price_usd} — ${r.airline} | ${r.stops === 0 ? "ישיר" : r.stops + " עצירות"} | ${r.source}\n`;
      }
      summary += `\n💡 המלצה: הדיל הטוב ביותר הוא $${cheapest} עם ${results[0].airline}`;
    }

    const aiResponse = {
      summary,
      results: results.slice(0, 5),
      cheapest_price: cheapest,
      search_time: new Date().toISOString(),
      sources_searched: [
        settings.serpapi_key ? "Google Flights" : null,
        settings.skyfare_key ? "SkyFare" : null,
      ].filter(Boolean),
    };

    // Update DB
    await sb
      .from("requests")
      .update({
        ai_response: aiResponse,
        cheapest_found: cheapest,
        status,
      })
      .eq("id", requestId);

    const servicePrice = settings.service_price || "249";
    const adminApproval = settings.admin_approval === "true";

    // If admin approval is enabled, stop here — admin will review in dashboard and approve
    if (adminApproval && status === "found") {
      // Send notification to admin via WhatsApp (if admin phone is configured)
      if (settings.green_instance && settings.green_token && settings.admin_whatsapp) {
        const adminWa = settings.admin_whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
        const adminChatId = `972${adminWa}@c.us`;
        let adminMsg = `🔔 בקשה חדשה מחכה לאישור!\n\n`;
        adminMsg += `👤 ${request.name} (${request.whatsapp})\n`;
        adminMsg += `✈️ ${request.from_iata} → ${request.to_iata}\n`;
        adminMsg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        adminMsg += summary;
        adminMsg += `\n\n⚠️ היכנס לדשבורד כדי לאשר את השליחה ללקוח.`;
        try {
          await fetch(
            `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: adminChatId, message: adminMsg }) }
          );
        } catch (e) {
          console.error("Admin WhatsApp notification error:", e);
        }
      }
      // Status stays "found" — admin approves from dashboard
    } else if (settings.green_instance && settings.green_token && status === "found") {
      // No admin approval — send directly to customer
      const wa = request.whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
      const chatId = `972${wa}@c.us`;

      let whatsappMsg = `שלום ${request.name} 👋\n\n`;
      whatsappMsg += `🔍 סיימנו לחפש עבורך!\n\n`;
      whatsappMsg += summary;
      whatsappMsg += `\n\n💳 המחיר לשירות: ₪${servicePrice}`;
      whatsappMsg += `\nרוצה להמשיך? השב *כן* כדי לקבל קישור לתשלום.`;
      whatsappMsg += `\n\n_צייד טיסות ✈️_`;

      try {
        await fetch(
          `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, message: whatsappMsg }),
          }
        );
        // Update status to sent_price
        await sb.from("requests").update({ status: "sent_price" }).eq("id", requestId);
      } catch (e) {
        console.error("WhatsApp send error:", e);
      }
    }

    return new Response(JSON.stringify({ success: true, status, results_count: results.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("search-flights error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
