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

// Create SUMIT payment link via BeginRedirect API
async function createPaymentLink(settings: any, request: any): Promise<string> {
  if (!settings.sumit_company_id || !settings.sumit_api_key) return "";
  const servicePrice = parseInt(settings.service_price || "249");
  try {
    const resp = await fetch("https://api.sumit.co.il/billing/payments/beginredirect/", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        Credentials: {
          CompanyID: parseInt(settings.sumit_company_id),
          APIKey: settings.sumit_api_key,
        },
        Customer: {
          Name: request.name,
          Phone: request.whatsapp,
          EmailAddress: request.email || "",
        },
        Items: [{
          Item: {
            Name: `\u05E6\u05D9\u05D9\u05D3 \u05D4\u05D8\u05D9\u05E1\u05D5\u05EA - ${request.id.slice(0, 8)}`,
            Price: servicePrice,
            Currency: "ILS",
          },
          Quantity: 1,
          UnitPrice: servicePrice,
          Description: `${request.from_iata} > ${request.to_iata}`,
        }],
        VATIncluded: true,
        RedirectURL: `${SB_URL}/functions/v1/handle-payment?request_id=${request.id}`,
        ExternalIdentifier: request.id,
        MaximumPayments: 1,
        SendUpdateByEmailAddress: request.email || "",
        ExpirationHours: 48,
      }),
    });
    const data = await resp.json();
    return data.RedirectURL || data.Data?.RedirectURL || "";
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
    msg += `\n\n⚠️ *שים לב:*\n`;
    msg += `• המחירים נכונים לרגע החיפוש ועשויים להשתנות\n`;
    msg += `• אנחנו מאתרים טיסות — ההזמנה מתבצעת ישירות מול חברת התעופה או אתר ההזמנות\n`;
    msg += `• המחירים כוללים מס ועמלות ידועות אך עלולים להשתנות בעת ההזמנה\n`;
    msg += `• כבודה, בחירת מושב ותוספות נוספות עשויים להיות בתשלום נפרד\n`;
    msg += `\n🧪 *מצב טסט* — תשלום אוטומטי\n`;
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

  // Disclaimers
  const disclaimers =
    `\n\n⚠️ *שים לב:*\n` +
    `• המחירים נכונים לרגע החיפוש ועשויים להשתנות\n` +
    `• אנחנו מאתרים טיסות — ההזמנה מתבצעת ישירות מול חברת התעופה או אתר ההזמנות\n` +
    `• המחירים כוללים מס ועמלות ידועות אך עלולים להשתנות בעת ההזמנה\n` +
    `• כבודה, בחירת מושב ותוספות נוספות עשויים להיות בתשלום נפרד\n`;

  // Production — create SUMIT link and send with teaser
  const paymentUrl = await createPaymentLink(settings, request);
  let msg = `שלום ${request.name} 👋\n\n`;
  msg += teaser;
  msg += disclaimers;
  msg += `\n💳 *לתשלום ₪${servicePrice} וקבלת הפרטים המלאים:*\n`;
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
      if (!r) return new Response(JSON.stringify({ error: "request not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

      // Prevent duplicate sends — only approve if status is still "found"
      if (r.status !== "found") {
        return new Response(JSON.stringify({
          success: false,
          message: `הבקשה כבר טופלה (סטטוס: ${r.status})`,
          request_id: reqId,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: sData } = await sb.rpc("get_settings_json");
      const s = sData || {};
      const aiResp = r.ai_response || {};

      // Send TEASER + payment link to customer via WhatsApp
      if (s.green_instance && s.green_token) {
        const teaser = aiResp.customer_teaser || "מצאנו תוצאות מעולות!";
        await sendTeaserWithPayment(sb, s, r, teaser);
      }

      return new Response(JSON.stringify({
        success: true,
        message: `הבקשה אושרה! ההצעה נשלחה ללקוח ${r.name} ב-WhatsApp.`,
        request_id: reqId,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

    // ---------- VIP requests — notify admin with free text, no search ----------
    if (request.type === "vip") {
      await sb.from("requests").update({
        status: "found",
        ai_response: { admin_summary: `👑 *בקשת VIP*\n\n${request.notes || '(ללא פרטים)'}`, customer_teaser: "", results: [] },
      }).eq("id", requestId);

      if (settings.green_instance && settings.green_token) {
        // Confirm to customer
        const wa = request.whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
        const chatId = `972${wa}@c.us`;
        let custMsg = `שלום ${request.name} 👋\n\n`;
        custMsg += `👑 *בקשת ה-VIP שלך התקבלה!*\n\n`;
        custMsg += `סוכן אישי יבדוק את הבקשה ויחזור אליך בהקדם.\n\n`;
        custMsg += `📋 מספר בקשה: ${requestId}\n`;
        custMsg += `_צייד טיסות ✈️_`;
        await fetch(
          `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: custMsg }) }
        );

        // Notify admin
        if (settings.admin_whatsapp) {
          const adminWa = settings.admin_whatsapp.replace(/^0/, "").replace(/[^0-9]/g, "");
          const adminChatId = `972${adminWa}@c.us`;
          let adminMsg = `👑 *בקשת VIP חדשה!*\n\n`;
          adminMsg += `👤 ${request.name} (${request.whatsapp})\n`;
          if (request.email) adminMsg += `📧 ${request.email}\n`;
          adminMsg += `\n📝 *תוכן הבקשה:*\n${request.notes || '(ללא פרטים)'}\n\n`;
          adminMsg += `💰 מחיר VIP: ₪${settings.vip_price || '299'}\n`;
          adminMsg += `📋 בקשה: ${requestId}\n\n`;
          adminMsg += `_צייד טיסות ✈️_`;
          await fetch(
            `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: adminChatId, message: adminMsg }) }
          );
        }
      }

      return new Response(JSON.stringify({ success: true, status: "found", type: "vip" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Search flights from multiple sources ----------
    // For round-trip, search each direction separately as one-way
    const isRoundTrip = !request.is_one_way && request.return_date;
    const directions = isRoundTrip
      ? [
          { from: request.from_iata, to: request.to_iata, date: request.depart_date, label: "הלוך" },
          { from: request.to_iata, to: request.from_iata, date: request.return_date, label: "חזור" },
        ]
      : [
          { from: request.from_iata, to: request.to_iata, date: request.depart_date, label: "הלוך" },
        ];

    // Search function for a single direction (always one-way)
    async function searchOneDirection(from: string, to: string, date: string): Promise<any[]> {
      const dirResults: any[] = [];

      // 1. SerpApi (Google Flights) — always type=2 (one-way)
      if (settings.serpapi_key) {
        try {
          const params = new URLSearchParams({
            engine: "google_flights",
            departure_id: from,
            arrival_id: to,
            outbound_date: date,
            type: "2",
            adults: String(request.adults),
            children: String(request.children || 0),
            currency: "USD",
            api_key: settings.serpapi_key,
          });

          const serpResp = await fetch(`https://serpapi.com/search.json?${params}`);
          const serpData = await serpResp.json();

          const bestFlights = serpData.best_flights || [];
          const otherFlights = serpData.other_flights || [];
          const allFlights = [...bestFlights, ...otherFlights];

          for (const flight of allFlights.slice(0, 5)) {
            const firstLeg = flight.flights?.[0];
            const lastLeg = flight.flights?.[flight.flights?.length - 1];
            const airline = firstLeg?.airline || "";
            if (!airline || airline === "Unknown") continue; // skip unknown airlines
            dirResults.push({
              source: "Google Flights",
              price_usd: flight.price,
              airline,
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

      // 2. Skyscanner via Flights Scraper Sky (RapidAPI) — always one-way
      if (settings.skyfare_key) {
        try {
          const rapidApiKey = settings.skyfare_key;
          const skyParams: any = {
            fromEntityId: from,
            toEntityId: to,
            departDate: date,
            adults: String(request.adults),
            currency: "USD",
          };
          const qs = new URLSearchParams(skyParams).toString();

          const skyResp = await fetch(
            `https://flights-sky.p.rapidapi.com/flights/search-one-way?${qs}`,
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
              const airline = firstLeg?.carriers?.marketing?.[0]?.name || "";
              if (!airline || airline === "Unknown") continue;
              dirResults.push({
                source: "Skyscanner",
                price_usd: Math.round(itin.price?.raw || 0),
                airline,
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

      // 3. Kiwi.com via RapidAPI — always one-way
      if (settings.skyfare_key) {
        try {
          const rapidApiKey = settings.skyfare_key;
          const totalPax = (request.adults || 1) + (request.children || 0);
          const kiwiParams: Record<string, string> = {
            source: `City:${from}`,
            destination: `City:${to}`,
            departureDate: date,
            currency: "usd",
            locale: "en",
            adults: "1",
            children: "0",
            infants: "0",
            handbags: "1",
            holdbags: "0",
            cabinClass: "ECONOMY",
            sortBy: "PRICE",
            sortOrder: "ASCENDING",
            limit: "10",
            transportTypes: "FLIGHT",
            enableSelfTransfer: "true",
            allowDifferentStationConnection: "true",
            allowOvernightStopover: "true",
            enableThrowAwayTicketing: "true",
            allowChangeInboundSource: "true",
            allowChangeInboundDestination: "true",
            applyMixedClasses: "true",
            allowReturnFromDifferentCity: "true",
          };

          const kiwiResp = await fetch(
            `https://kiwi-com-cheap-flights.p.rapidapi.com/one-way?${new URLSearchParams(kiwiParams)}`,
            {
              headers: {
                "Content-Type": "application/json",
                "X-RapidAPI-Key": rapidApiKey,
                "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com",
              },
            }
          );

          if (kiwiResp.ok) {
            const kiwiData = await kiwiResp.json();
            const itineraries = kiwiData.itineraries || [];
            for (const itin of itineraries.slice(0, 5)) {
              const outbound = itin.outbound || {};
              const sectorSegs = outbound.sectorSegments || [];
              const firstSeg = sectorSegs[0]?.segment || {};
              const lastSeg = sectorSegs[sectorSegs.length - 1]?.segment || firstSeg;
              const pricePerPerson = parseFloat(itin.price?.amount || "0");
              const priceUsd = pricePerPerson * totalPax;
              const durationSec = outbound.duration || 0;

              const segAirlines = sectorSegs.map((ss: any) => ss.segment?.carrier?.name).filter(Boolean);
              const uniqueAirlines = [...new Set(segAirlines)];
              const isVirtualInterline = uniqueAirlines.length > 1;
              const airlineLabel = isVirtualInterline ? uniqueAirlines.join(" + ") : (firstSeg.carrier?.name || "");
              if (!airlineLabel) continue; // skip unknown airlines

              dirResults.push({
                source: "Kiwi.com",
                price_usd: Math.round(priceUsd),
                airline: airlineLabel,
                is_virtual_interline: isVirtualInterline,
                stops: Math.max(0, sectorSegs.length - 1),
                duration_minutes: Math.round(durationSec / 60),
                departure_time: firstSeg.source?.localTime || "",
                arrival_time: lastSeg.destination?.localTime || "",
                departure_airport: firstSeg.source?.station?.name || "",
                arrival_airport: lastSeg.destination?.station?.name || "",
                booking_url: null,
                flights_detail: sectorSegs.map((ss: any) => {
                  const seg = ss.segment || {};
                  return {
                    airline: seg.carrier?.name || "",
                    flight_number: `${seg.carrier?.code || ""}${seg.code || ""}`,
                    departure: { id: seg.source?.station?.code, time: seg.source?.localTime },
                    arrival: { id: seg.destination?.station?.code, time: seg.destination?.localTime },
                    duration: Math.round((seg.duration || 0) / 60),
                  };
                }),
              });
            }
          } else {
            console.error("Kiwi API error:", kiwiResp.status, await kiwiResp.text());
          }
        } catch (e) {
          console.error("Kiwi/RapidAPI error:", e);
        }
      }

      return dirResults;
    }

    // Helper: deduplicate and sort results for one direction
    function deduplicateAndSort(rawResults: any[]): any[] {
      const dedupMap = new Map<string, any>();
      for (const r of rawResults) {
        const durBucket = Math.round((r.duration_minutes || 0) / 15) * 15;
        const key = `${r.airline}|${r.stops}|${durBucket}`;
        const existing = dedupMap.get(key);
        if (!existing || r.price_usd < existing.price_usd) {
          dedupMap.set(key, r);
        }
      }
      const deduped = Array.from(dedupMap.values());
      // Sort: directs first, then by price
      deduped.sort((a, b) => {
        if (a.stops === 0 && b.stops > 0) return -1;
        if (a.stops > 0 && b.stops === 0) return 1;
        return (a.price_usd || 9999) - (b.price_usd || 9999);
      });
      // Only keep connections that are cheaper than cheapest direct
      const cheapestDirectPrice = deduped.find(r => r.stops === 0)?.price_usd;
      if (cheapestDirectPrice) {
        return deduped.filter(r => r.stops === 0 || r.price_usd < cheapestDirectPrice);
      }
      return deduped;
    }

    // Search all directions in parallel
    const directionResults: { dir: typeof directions[0], raw: any[], deduped: any[] }[] = [];
    const searchPromises = directions.map(async (dir) => {
      const raw = await searchOneDirection(dir.from, dir.to, dir.date);
      const deduped = deduplicateAndSort(raw);
      return { dir, raw, deduped };
    });
    const searchResults = await Promise.all(searchPromises);
    directionResults.push(...searchResults);

    // Flatten all results for stats
    const allRawResults = directionResults.flatMap(d => d.raw);
    const allDeduped = directionResults.flatMap(d => d.deduped);

    // Engine stats for admin
    const googleCount = allRawResults.filter(r => r.source === "Google Flights").length;
    const skyCount = allRawResults.filter(r => r.source === "Skyscanner").length;
    const kiwiCount = allRawResults.filter(r => r.source === "Kiwi.com").length;
    let engineStats = `🔎 *מנועי חיפוש:*\n`;
    if (settings.serpapi_key) engineStats += `  • Google Flights: ${googleCount > 0 ? googleCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
    if (settings.skyfare_key) engineStats += `  • Skyscanner: ${skyCount > 0 ? skyCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
    if (settings.skyfare_key) engineStats += `  • Kiwi.com: ${kiwiCount > 0 ? kiwiCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
    if (!settings.serpapi_key && !settings.skyfare_key) engineStats += `  ⚠️ אין מפתחות API מוגדרים!\n`;
    const viCount = allDeduped.filter(r => r.is_virtual_interline).length;
    if (viCount > 0) engineStats += `  🔗 קונקשנים חכמים (Virtual Interline): ${viCount}\n`;
    engineStats += `  📊 סה"כ: ${allDeduped.length} תוצאות ייחודיות (מתוך ${allRawResults.length})\n`;

    const fmtDur = (m: number) => `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`;

    // Helper: build per-direction summary sections
    function buildDirectionSummary(deduped: any[], dirLabel: string, fromIata: string, toIata: string, date: string) {
      let admin = "";
      let customer = "";
      const cheapest = deduped.length > 0 ? deduped[0] : null;
      const directResults = deduped.filter(r => r.stops === 0);
      const connResults = deduped.filter(r => r.stops > 0);

      admin += `\n✈️ *${dirLabel}: ${heCity(fromIata)} → ${heCity(toIata)}* (${date})\n\n`;
      if (directResults.length > 0) {
        admin += `🛫 *טיסות ישירות:*\n`;
        for (let i = 0; i < Math.min(5, directResults.length); i++) {
          const r = directResults[i];
          admin += `  ${i + 1}. $${r.price_usd} — ${r.airline} | ${fmtDur(r.duration_minutes)} | 🔎 ${r.source}\n`;
        }
      }
      if (connResults.length > 0) {
        admin += `\n🔗 *קונקשן (זול מישירה):*\n`;
        for (let i = 0; i < Math.min(3, connResults.length); i++) {
          const r = connResults[i];
          admin += `  ${i + 1}. $${r.price_usd} — ${r.airline} | ${r.stops} עצירות | ${fmtDur(r.duration_minutes)}${r.is_virtual_interline ? " 🔗" : ""} | 🔎 ${r.source}\n`;
          // Show segments
          if (r.flights_detail && r.flights_detail.length > 0) {
            for (let si = 0; si < r.flights_detail.length; si++) {
              const seg = r.flights_detail[si];
              admin += `     ${seg.airline} ${seg.flight_number || ''} | ${seg.departure?.id || ''} ${seg.departure?.time?.slice(11,16) || ''} → ${seg.arrival?.id || ''} ${seg.arrival?.time?.slice(11,16) || ''}`;
              if (seg.duration) admin += ` (${fmtDur(seg.duration)})`;
              admin += `\n`;
              if (si < r.flights_detail.length - 1) {
                const nextSeg = r.flights_detail[si+1];
                const arrTime = new Date(seg.arrival?.time || 0).getTime();
                const depTime = new Date(nextSeg.departure?.time || 0).getTime();
                if (arrTime && depTime && depTime > arrTime) {
                  const layoverMin = Math.round((depTime - arrTime) / 60000);
                  admin += `     ⏳ המתנה: ${fmtDur(layoverMin)} שעות\n`;
                }
              }
            }
          }
        }
      }
      if (deduped.length === 0) {
        admin += `  ❌ לא נמצאו טיסות לכיוון זה\n`;
      }

      // Customer summary for this direction
      customer += `\n✈️ *${dirLabel}: ${heCity(fromIata)} → ${heCity(toIata)}* (${date})\n`;
      if (cheapest) {
        customer += `💰 מ-*$${cheapest.price_usd}*`;
        if (directResults.length > 0) {
          customer += ` | ${directResults.length} טיסות ישירות`;
        }
        if (connResults.length > 0) {
          customer += ` | ${connResults.length} קונקשנים זולים`;
        }
        customer += `\n`;
        // Booking link for cheapest flight
        if (cheapest.booking_token) {
          customer += `🔗 הזמנה: https://www.google.com/travel/flights/booking?token=${cheapest.booking_token}\n`;
        } else if (cheapest.booking_url) {
          customer += `🔗 הזמנה: ${cheapest.booking_url}\n`;
        }
      } else {
        customer += `❌ לא נמצאו טיסות\n`;
      }

      return { admin, customer, cheapest: cheapest?.price_usd || null };
    }

    const isBeat = request.type === "beat";
    let status = "found";

    // Overall cheapest across all directions
    const cheapest = allDeduped.length > 0 ? Math.min(...allDeduped.map(r => r.price_usd)) : null;

    // --- Build TWO summaries: one for admin (full), one for customer (teaser) ---

    let adminSummary = "";   // Full details — for admin + after payment
    let customerTeaser = ""; // No prices/details — for customer before payment

    if (allDeduped.length === 0) {
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
      // For beat mode, use outbound direction cheapest
      const outboundCheapest = directionResults[0]?.deduped[0]?.price_usd;
      if (outboundCheapest && outboundCheapest < customerPrice) {
        const saving = customerPrice - outboundCheapest;
        const savingPct = Math.round((saving / customerPrice) * 100);

        // Admin gets per-direction results
        adminSummary = `🎉 מצאנו טיסה זולה יותר!\n\n`;
        adminSummary += `המחיר של הלקוח: $${customerPrice}\n`;
        adminSummary += `המחיר שמצאנו (הלוך): $${outboundCheapest}\n`;
        adminSummary += `חיסכון: $${saving} (${savingPct}%)\n`;
        for (const dr of directionResults) {
          const dirSum = buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date);
          adminSummary += dirSum.admin;
        }
        adminSummary += `\n${engineStats}`;

        // Customer teaser
        customerTeaser = `🎉 חדשות מעולות!\n\n`;
        customerTeaser += `מצאנו טיסה ב-*$${outboundCheapest}* במקום $${customerPrice} שמצאת!\n`;
        customerTeaser += `💰 חיסכון של *$${saving}* (${savingPct}%)\n`;
        if (isRoundTrip) {
          customerTeaser += `\n🔄 *הלוך ושוב — הצעות לכל כיוון בנפרד:*\n`;
          for (const dr of directionResults) {
            const dirSum = buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date);
            customerTeaser += dirSum.customer;
          }
        }
        customerTeaser += `\nלקבלת כל הפרטים המלאים (חברה, שעות, קישור הזמנה) — אשר תשלום.\n\n`;
        customerTeaser += `📋 מספר בקשה: ${requestId}`;
      } else {
        adminSummary = `לא מצאנו מחיר זול יותר מ-$${customerPrice}.\n`;
        adminSummary += `המחיר הזול ביותר שמצאנו: $${outboundCheapest || cheapest}\n`;
        adminSummary += `ייתכן שהמחיר שמצא הלקוח הוא כבר הדיל הכי טוב.\n\n`;
        adminSummary += engineStats;
        customerTeaser = `שלום ${request.name} 👋\n\n`;
        customerTeaser += `חיפשנו עבורך טיסה זולה יותר מ-*$${customerPrice}* שמצאת:\n\n`;
        customerTeaser += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        customerTeaser += `🔄 ${tripLabel(request)}\n`;
        customerTeaser += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        customerTeaser += `לצערנו, המחיר שמצאת הוא כבר מצוין — לא הצלחנו להכות אותו! 👏\n`;
        customerTeaser += `המחיר הזול ביותר שמצאנו: *$${outboundCheapest || cheapest}*\n\n`;
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
      // Research — per-direction results
      adminSummary = `📊 דוח מחקר טיסות\n`;
      adminSummary += `${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      adminSummary += `🔄 ${tripLabel(request)}\n`;
      adminSummary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
      adminSummary += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n`;
      for (const dr of directionResults) {
        const dirSum = buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date);
        adminSummary += dirSum.admin;
      }
      adminSummary += `\n${engineStats}`;

      // Customer teaser
      customerTeaser = `📊 הדוח שלך מוכן!\n\n`;
      customerTeaser += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
      customerTeaser += `🔄 ${tripLabel(request)}\n`;
      customerTeaser += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
      if (isRoundTrip) {
        customerTeaser += `🔄 *הצעות לכל כיוון בנפרד:*\n`;
        for (const dr of directionResults) {
          const dirSum = buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date);
          customerTeaser += dirSum.customer;
        }
      } else {
        customerTeaser += `🔍 מצאנו *${allDeduped.length} טיסות*\n`;
        customerTeaser += `💰 המחיר הזול ביותר: *$${cheapest}*\n`;
        // Booking link for cheapest
        const cheapestResult = allDeduped[0];
        if (cheapestResult?.booking_token) {
          customerTeaser += `🔗 הזמנה: https://www.google.com/travel/flights/booking?token=${cheapestResult.booking_token}\n`;
        } else if (cheapestResult?.booking_url) {
          customerTeaser += `🔗 הזמנה: ${cheapestResult.booking_url}\n`;
        }
      }
      customerTeaser += `\nלקבלת הדוח המלא עם חברות, שעות וקישורי הזמנה — אשר תשלום.\n\n`;
      customerTeaser += `📋 מספר בקשה: ${requestId}`;
    }

    const aiResponse = {
      admin_summary: adminSummary,
      customer_teaser: customerTeaser,
      results: allDeduped.slice(0, 10),
      direction_results: directionResults.map(dr => ({
        label: dr.dir.label,
        from: dr.dir.from,
        to: dr.dir.to,
        date: dr.dir.date,
        results: dr.deduped.slice(0, 5),
      })),
      cheapest_price: cheapest,
      search_time: new Date().toISOString(),
      sources_searched: [
        settings.serpapi_key ? "Google Flights" : null,
        settings.skyfare_key ? "Skyscanner" : null,
        settings.skyfare_key ? "Kiwi.com" : null,
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

    return new Response(JSON.stringify({ success: true, status, results_count: allDeduped.length }), {
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
