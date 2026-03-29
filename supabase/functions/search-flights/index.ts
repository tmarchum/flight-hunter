import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://stncskqjrmecjckxldvi.supabase.co";
const SB_KEY = "sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I";

// Hebrew airport names for WhatsApp messages
const AIRPORT_NAMES: Record<string, string> = {
  TLV:'תל אביב',ETH:'אילת',LHR:'לונדון',LGW:'לונדון',CDG:'פריז',ORY:'פריז',
  FCO:'רומא',MXP:'מילאנו',VCE:'ונציה',NAP:'נאפולי',BCN:'ברצלונה',MAD:'מדריד',
  ATH:'אתונה',SKG:'סלוניקי',HER:'כרתים',RHO:'רודוס',JMK:'מיקונוס',JTR:'סנטוריני',
  BER:'ברלין',MUC:'מינכן',FRA:'פרנקפורט',AMS:'אמסטרדם',BRU:'בריסל',
  VIE:'וינה',ZRH:'ציריך',GVA:'ז\'נבה',PRG:'פראג',BUD:'בודפשט',WAW:'ורשה',KRK:'קרקוב',
  CPH:'קופנהגן',OSL:'אוסלו',ARN:'סטוקהולם',LIS:'ליסבון',OPO:'פורטו',DUB:'דבלין',
  IST:'איסטנבול',AYT:'אנטליה',SOF:'סופיה',OTP:'בוקרשט',
  JFK:'ניו יורק',EWR:'ניו יורק',LAX:'לוס אנג\'לס',SFO:'סן פרנסיסקו',MIA:'מיאמי',
  BKK:'בנגקוק',HKT:'פוקט',DEL:'ניו דלהי',DXB:'דובאי',AMM:'עמאן',
  LCA:'לרנקה',SSH:'שארם א-שייח',HRG:'הורגדה',
};
const heCity = (iata: string) => AIRPORT_NAMES[iata] ? `${AIRPORT_NAMES[iata]} (${iata})` : iata;
const tripLabel = (r: any) => r.is_one_way ? 'הלוך בלבד' : 'הלוך ושוב';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Create SUMIT payment link
async function createPaymentLink(settings: any, request: any): Promise<string> {
  if (!settings.sumit_company_id || !settings.sumit_api_key) return "";
  const servicePrice = parseInt(settings.service_price || "249");
  try {
    const resp = await fetch("https://api.sumit.co.il/billing/paymentrequest/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CompanyID: settings.sumit_company_id,
        APIKey: settings.sumit_api_key,
        Customers: [{ Name: request.name, Phone: request.whatsapp, EmailAddress: request.email || "" }],
        Items: [{
          Name: request.type === "beat"
            ? `הכה את המחיר — ${request.from_iata}→${request.to_iata}`
            : `דוח מחקר טיסות — ${request.from_iata}→${request.to_iata}`,
          Price: servicePrice, Quantity: 1, Currency: "ILS",
        }],
        RedirectURL: `${SB_URL}/functions/v1/handle-payment?request_id=${request.id}`,
        MaxPayments: 1, DraftInvoice: true, SendEmail: !!request.email, SendSMS: false,
      }),
    });
    const data = await resp.json();
    return data.PaymentRequestURL || data.Data?.PaymentRequestURL || "";
  } catch (e) {
    console.error("SUMIT error:", e);
    return "";
  }
}

// Send teaser + payment link to customer, or auto-pay in test mode
async function sendTeaserWithPayment(sb: any, settings: any, request: any, teaser: string) {
  const servicePrice = settings.service_price || "249";
  const testMode = settings.test_mode === "true";
  const wa = request.whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
  const chatId = `972${wa}@c.us`;

  if (testMode) {
    // Test mode — send teaser, then auto-pay and send full details
    let msg = `שלום ${request.name} 👋\n\n`;
    msg += teaser;
    msg += `\n\n🧪 *מצב טסט* — תשלום אוטומטי\n`;
    msg += `_צייד טיסות ✈️_`;
    await fetch(
      `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: msg }) }
    );
    // Auto-pay
    await sb.from("requests").update({
      status: "paid", payment_id: "TEST_MODE",
      amount_paid: parseInt(servicePrice), paid_at: new Date().toISOString(),
    }).eq("id", request.id);
    // Trigger handle-payment to send full details
    try {
      await fetch(`${SB_URL}/functions/v1/handle-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_KEY}` },
        body: JSON.stringify({ request_id: request.id, payment_id: "TEST_MODE", amount: parseInt(servicePrice) }),
      });
    } catch (e) {
      console.error("Test mode handle-payment error:", e);
    }
    return;
  }

  // Production — create SUMIT link and send with teaser
  const paymentUrl = await createPaymentLink(settings, request);
  let msg = `שלום ${request.name} 👋\n\n`;
  msg += teaser;
  msg += `\n\n💳 *לתשלום ₪${servicePrice} וקבלת הפרטים המלאים:*\n`;
  if (paymentUrl) {
    msg += `${paymentUrl}\n`;
  } else {
    msg += `⚠️ לא הצלחנו ליצור קישור תשלום. צור קשר איתנו.\n`;
  }
  msg += `\n_צייד טיסות ✈️_`;
  await fetch(
    `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: msg }) }
  );
  await sb.from("requests").update({ status: "awaiting_payment" }).eq("id", request.id);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(SB_URL, SB_KEY);
    const url = new URL(req.url);

    // --- Handle admin approval link (GET ?action=approve&request_id=xxx) ---
    if (req.method === "GET" && url.searchParams.get("action") === "approve") {
      const reqId = url.searchParams.get("request_id") || "";
      if (!reqId) {
        return new Response("missing request_id", { status: 400, headers: corsHeaders });
      }
      const { data: r } = await sb.from("requests").select("*").eq("id", reqId).single();
      if (!r) return new Response("request not found", { status: 404, headers: corsHeaders });

      const { data: sData } = await sb.rpc("get_settings_json");
      const s = sData || {};
      const sPrice = s.service_price || "249";
      const aiResp = r.ai_response || {};

      // Send TEASER + payment link to customer via WhatsApp
      if (s.green_instance && s.green_token) {
        const teaser = aiResp.customer_teaser || "מצאנו תוצאות מעולות!";
        await sendTeaserWithPayment(sb, s, r, teaser);
      }

      return new Response(
        `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>אושר — צייד טיסות</title>
<style>body{background:#0a0a0f;color:#f0f0f5;font-family:'Heebo',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center}
.box{max-width:400px;padding:40px}</style>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet">
</head><body><div class="box">
<div style="font-size:64px;margin-bottom:16px">✅</div>
<h1 style="font-size:28px;font-weight:900;margin:0 0 12px">הבקשה אושרה!</h1>
<p style="color:#6b7280;font-size:16px">ההצעה נשלחה ללקוח ${r.name} ב-WhatsApp.<br/>הלקוח יתבקש לאשר ולשלם.</p>
</div></body></html>`,
        { headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // --- Normal POST: search flights ---
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

        const bestFlights = serpData.best_flights || [];
        const otherFlights = serpData.other_flights || [];
        const allFlights = [...bestFlights, ...otherFlights];

        for (const flight of allFlights.slice(0, 5)) {
          const firstLeg = flight.flights?.[0];
          const lastLeg = flight.flights?.[flight.flights?.length - 1];
          results.push({
            source: "Google Flights",
            price_usd: flight.price,
            airline: firstLeg?.airline || "Unknown",
            stops: flight.flights ? flight.flights.length - 1 : 0,
            duration_minutes: flight.total_duration,
            departure_time: firstLeg?.departure_airport?.time || "",
            arrival_time: lastLeg?.arrival_airport?.time || "",
            departure_airport: firstLeg?.departure_airport?.name || "",
            arrival_airport: lastLeg?.arrival_airport?.name || "",
            booking_token: flight.booking_token || null,
            layovers: flight.layovers || [],
            flights_detail: (flight.flights || []).map((f: any) => ({
              airline: f.airline,
              flight_number: f.flight_number,
              airplane: f.airplane,
              departure: f.departure_airport,
              arrival: f.arrival_airport,
              duration: f.duration,
              legroom: f.legroom,
            })),
          });
        }
      } catch (e) {
        console.error("SerpApi error:", e);
      }
    }

    // 2. Skyscanner via Flights Scraper Sky (RapidAPI)
    if (settings.skyfare_key) {
      try {
        const rapidApiKey = settings.skyfare_key;
        const searchType = request.is_one_way ? "search-one-way" : "search-roundtrip";
        const skyParams: any = {
          fromEntityId: request.from_iata,
          toEntityId: request.to_iata,
          departDate: request.depart_date,
          adults: String(request.adults),
          currency: "USD",
        };
        if (!request.is_one_way && request.return_date) {
          skyParams.returnDate = request.return_date;
        }
        const qs = new URLSearchParams(skyParams).toString();

        const skyResp = await fetch(
          `https://flights-sky.p.rapidapi.com/flights/${searchType}?${qs}`,
          {
            headers: {
              "X-RapidAPI-Key": rapidApiKey,
              "X-RapidAPI-Host": "flights-sky.p.rapidapi.com",
            },
          }
        );

        if (skyResp.ok) {
          const skyData = await skyResp.json();
          const itineraries = skyData.data?.itineraries || [];

          for (const itin of itineraries.slice(0, 5)) {
            const legs = itin.legs || [];
            const firstLeg = legs[0];
            results.push({
              source: "Skyscanner",
              price_usd: Math.round(itin.price?.raw || 0),
              airline: firstLeg?.carriers?.marketing?.[0]?.name || "Unknown",
              stops: firstLeg?.stopCount || 0,
              duration_minutes: firstLeg?.durationInMinutes || 0,
              departure_time: firstLeg?.departure || "",
              arrival_time: firstLeg?.arrival || "",
              departure_airport: firstLeg?.origin?.name || "",
              arrival_airport: firstLeg?.destination?.name || "",
              booking_url: null,
              flights_detail: (firstLeg?.segments || []).map((s: any) => ({
                airline: s.operatingCarrier?.name || firstLeg?.carriers?.marketing?.[0]?.name,
                flight_number: s.flightNumber || "",
                departure: { id: s.origin?.flightPlaceId, name: s.origin?.name, time: s.departure },
                arrival: { id: s.destination?.flightPlaceId, name: s.destination?.name, time: s.arrival },
                duration: s.durationInMinutes,
              })),
            });
          }
        } else {
          console.error("Skyscanner API error:", skyResp.status, await skyResp.text());
        }
      } catch (e) {
        console.error("Skyscanner/RapidAPI error:", e);
      }
    }

    // Deduplicate — same airline + same price + same stops = likely same flight from different engines
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const r of results) {
      const key = `${r.airline}|${r.price_usd}|${r.stops}|${r.duration_minutes}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }

    // Sort by price
    deduped.sort((a, b) => (a.price_usd || 9999) - (b.price_usd || 9999));

    // Engine stats for admin
    const googleCount = results.filter(r => r.source === "Google Flights").length;
    const skyCount = results.filter(r => r.source === "Skyscanner").length;
    let engineStats = `🔎 *מנועי חיפוש:*\n`;
    if (settings.serpapi_key) engineStats += `  • Google Flights: ${googleCount > 0 ? googleCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
    if (settings.skyfare_key) engineStats += `  • Skyscanner: ${skyCount > 0 ? skyCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
    if (!settings.serpapi_key && !settings.skyfare_key) engineStats += `  ⚠️ אין מפתחות API מוגדרים!\n`;
    engineStats += `  📊 סה"כ: ${deduped.length} תוצאות ייחודיות (מתוך ${results.length})\n`;

    const cheapest = deduped.length > 0 ? deduped[0].price_usd : null;

    const isBeat = request.type === "beat";
    let status = "found";

    // --- Build TWO summaries: one for admin (full), one for customer (teaser) ---

    let adminSummary = "";   // Full details — for admin + after payment
    let customerTeaser = ""; // No prices/details — for customer before payment

    if (deduped.length === 0) {
      status = "not_found";
      adminSummary = `לא נמצאו תוצאות עבור החיפוש הזה.\n`;
      adminSummary += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      adminSummary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      adminSummary += engineStats;
      customerTeaser = `שלום ${request.name} 👋\n\n`;
      customerTeaser += `לצערנו, לא הצלחנו למצוא טיסות עבור החיפוש שלך:\n\n`;
      customerTeaser += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      customerTeaser += `🔄 ${tripLabel(request)}\n`;
      customerTeaser += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      customerTeaser += `💡 *טיפים לשיפור החיפוש:*\n`;
      customerTeaser += `• נסה תאריכים גמישים יותר (±3 ימים)\n`;
      customerTeaser += `• בדוק שדות תעופה חלופיים באותו אזור\n`;
      customerTeaser += `• נסה לחפש הלוך בלבד במקום הלוך ושוב\n`;
      customerTeaser += `• חפש בתקופה שונה — לפעמים שבוע קודם/אחר עושה הבדל גדול\n\n`;
      customerTeaser += `רוצה לנסות שוב? פשוט שלח בקשה חדשה באתר 🔄\n`;
      customerTeaser += `כמובן — *ללא חיוב* כי לא מצאנו.\n\n`;
      customerTeaser += `📋 מספר בקשה: ${requestId}\n`;
      customerTeaser += `_צייד טיסות ✈️_`;
    } else if (isBeat) {
      const customerPrice = request.customer_price_usd || 0;
      if (cheapest && cheapest < customerPrice) {
        const saving = customerPrice - cheapest;
        const savingPct = Math.round((saving / customerPrice) * 100);

        // Admin gets full details + engine info
        adminSummary = `🎉 מצאנו טיסה זולה יותר!\n\n`;
        adminSummary += `המחיר של הלקוח: $${customerPrice}\n`;
        adminSummary += `המחיר שמצאנו: $${cheapest}\n`;
        adminSummary += `חיסכון: $${saving} (${savingPct}%)\n\n`;
        for (let i = 0; i < Math.min(5, deduped.length); i++) {
          const r = deduped[i];
          adminSummary += `${i + 1}. $${r.price_usd} — ${r.airline} | ${r.stops === 0 ? "ישיר" : r.stops + " עצירות"} | 🔎 ${r.source}\n`;
        }
        adminSummary += `\n${engineStats}`;

        // Customer gets teaser — price yes, details no, NO source
        customerTeaser = `🎉 חדשות מעולות!\n\n`;
        customerTeaser += `מצאנו טיסה ב-*$${cheapest}* במקום $${customerPrice} שמצאת!\n`;
        customerTeaser += `💰 חיסכון של *$${saving}* (${savingPct}%)\n\n`;
        customerTeaser += `לקבלת כל הפרטים המלאים (חברה, שעות, קישור הזמנה) — אשר תשלום.\n\n`;
        customerTeaser += `📋 מספר בקשה: ${requestId}`;
      } else {
        adminSummary = `לא מצאנו מחיר זול יותר מ-$${customerPrice}.\n`;
        adminSummary += `המחיר הזול ביותר שמצאנו: $${cheapest}\n`;
        adminSummary += `ייתכן שהמחיר שמצא הלקוח הוא כבר הדיל הכי טוב.\n\n`;
        adminSummary += engineStats;
        customerTeaser = `שלום ${request.name} 👋\n\n`;
        customerTeaser += `חיפשנו עבורך טיסה זולה יותר מ-*$${customerPrice}* שמצאת:\n\n`;
        customerTeaser += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        customerTeaser += `🔄 ${tripLabel(request)}\n`;
        customerTeaser += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        customerTeaser += `לצערנו, המחיר שמצאת הוא כבר מצוין — לא הצלחנו להכות אותו! 👏\n`;
        customerTeaser += `המחיר הזול ביותר שמצאנו: *$${cheapest}*\n\n`;
        customerTeaser += `💡 *טיפים שיכולים לעזור:*\n`;
        customerTeaser += `• נסה תאריכים גמישים (±3 ימים) — הפרשים יכולים להגיע ל-30%\n`;
        customerTeaser += `• בדוק שדה תעופה חלופי (למשל סטנסטד במקום הית'רו)\n`;
        customerTeaser += `• נסה טיסה עם עצירה — לפעמים זול משמעותית\n`;
        customerTeaser += `• הזמן מוקדם — מחירים עולים ככל שמתקרבים לתאריך\n\n`;
        customerTeaser += `רוצה לנסות שוב עם פרמטרים אחרים? שלח בקשה חדשה 🔄\n`;
        customerTeaser += `כמובן — *ללא חיוב* כי לא הכינו את המחיר.\n\n`;
        customerTeaser += `📋 מספר בקשה: ${requestId}\n`;
        customerTeaser += `_צייד טיסות ✈️_`;
        status = "not_found";
      }
    } else {
      // Research
      adminSummary = `📊 דוח מחקר טיסות\n`;
      adminSummary += `${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      adminSummary += `🔄 ${tripLabel(request)}\n`;
      adminSummary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      adminSummary += `🏆 ${Math.min(5, deduped.length)} הדילים הכי טובים:\n\n`;
      for (let i = 0; i < Math.min(5, deduped.length); i++) {
        const r = deduped[i];
        adminSummary += `${i + 1}. $${r.price_usd} — ${r.airline} | ${r.stops === 0 ? "ישיר" : r.stops + " עצירות"} | 🔎 ${r.source}\n`;
      }
      adminSummary += `\n💡 המלצה: הדיל הטוב ביותר הוא $${cheapest} עם ${deduped[0].airline}`;
      adminSummary += `\n\n${engineStats}`;

      // Customer gets teaser — cheapest price yes, full details no, NO source
      customerTeaser = `📊 הדוח שלך מוכן!\n\n`;
      customerTeaser += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      customerTeaser += `🔄 ${tripLabel(request)}\n`;
      customerTeaser += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      customerTeaser += `🔍 מצאנו *${deduped.length} טיסות*\n`;
      customerTeaser += `💰 המחיר הזול ביותר: *$${cheapest}*\n\n`;
      customerTeaser += `לקבלת הדוח המלא עם חברות, שעות וקישורי הזמנה — אשר תשלום.\n\n`;
      customerTeaser += `📋 מספר בקשה: ${requestId}`;
    }

    const aiResponse = {
      admin_summary: adminSummary,
      customer_teaser: customerTeaser,
      results: deduped.slice(0, 5),
      cheapest_price: cheapest,
      search_time: new Date().toISOString(),
      sources_searched: [
        settings.serpapi_key ? "Google Flights" : null,
        settings.skyfare_key ? "Skyscanner" : null,
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
    const approveUrl = `${SB_URL}/functions/v1/search-flights?action=approve&request_id=${requestId}`;

    // Send "not found" message directly to customer (no payment needed)
    if (status === "not_found" && settings.green_instance && settings.green_token) {
      const wa = request.whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
      const chatId = `972${wa}@c.us`;
      try {
        await fetch(
          `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: customerTeaser }) }
        );
      } catch (e) {
        console.error("WhatsApp not_found send error:", e);
      }
      // Also notify admin
      if (settings.admin_whatsapp) {
        const adminWa = settings.admin_whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
        const adminChatId = `972${adminWa}@c.us`;
        let adminMsg = `⚠️ *חיפוש ללא תוצאות*\n\n`;
        adminMsg += `👤 ${request.name} (${request.whatsapp})\n`;
        adminMsg += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        adminMsg += `🔄 ${tripLabel(request)}\n`;
        adminMsg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        adminMsg += adminSummary;
        adminMsg += `\n\n_הלקוח קיבל הודעה עם טיפים לשיפור החיפוש._\n`;
        adminMsg += `_צייד טיסות ✈️_`;
        try {
          await fetch(
            `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: adminChatId, message: adminMsg }) }
          );
        } catch (e) {
          console.error("Admin not_found notification error:", e);
        }
      }
    }

    // If admin approval is enabled, send admin full details + approval link
    if (adminApproval && status === "found") {
      if (settings.green_instance && settings.green_token && settings.admin_whatsapp) {
        const adminWa = settings.admin_whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
        const adminChatId = `972${adminWa}@c.us`;
        let adminMsg = `🔔 *בקשה חדשה מחכה לאישורך!*\n\n`;
        adminMsg += `👤 ${request.name} (${request.whatsapp})\n`;
        adminMsg += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        adminMsg += `🔄 ${tripLabel(request)}\n`;
        adminMsg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
        adminMsg += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n`;
        if (isBeat) adminMsg += `💰 המחיר של הלקוח: $${request.customer_price_usd}${request.customer_price_source ? " (" + request.customer_price_source + ")" : ""}\n`;
        adminMsg += `\n`;
        adminMsg += adminSummary;
        adminMsg += `\n\n✅ *לאישור ושליחה ללקוח — לחץ כאן:*\n${approveUrl}\n\n`;
        adminMsg += `_צייד טיסות ✈️_`;
        try {
          await fetch(
            `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: adminChatId, message: adminMsg }) }
          );
        } catch (e) {
          console.error("Admin WhatsApp notification error:", e);
        }
      }
    } else if (settings.green_instance && settings.green_token && status === "found") {
      // No admin approval — send TEASER + payment link directly to customer
      try {
        await sendTeaserWithPayment(sb, settings, request, customerTeaser);
      } catch (e) {
        console.error("WhatsApp/payment send error:", e);
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
