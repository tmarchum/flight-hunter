// =============================================================
// search-flights — main Edge Function
// Handles: GET ?action=approve (admin approval), POST {id} (search)
// =============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SB_URL, SB_PUBLISHABLE,
  corsHeaders, jsonResponse, htmlResponse,
  AIRPORT_NAMES, heCity, tripLabel,
  normalizeIsraeliPhone, toChatId,
  fetchWithTimeout, fetchRetry, sendWhatsApp,
  isValidIATA, isValidISODate, isFutureOrTodayDate, isValidEmail,
  logInfo, logError,
} from "../_shared/utils.ts";

// =============================================================
// Constants
// =============================================================

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const MANAGED_AGENTS_DEADLINE_MS = 22_000; // hard cap to stay inside Edge CPU budget
const MANAGED_AGENTS_POLL_MS = 1_500;
const SERPAPI_TIMEOUT_MS = 15_000;
const SKYSCANNER_TIMEOUT_MS = 15_000;
const KIWI_TIMEOUT_MS = 15_000;

// =============================================================
// SUMIT — payment link creation
// =============================================================

async function createPaymentLink(
  settings: any,
  request: any,
  priceOverride?: number
): Promise<{ url: string; price: number; error?: string }> {
  const isVip = request.type === "vip";
  const price = priceOverride ?? parseInt(
    isVip ? (settings.vip_price || "399") : (settings.service_price || "249")
  );

  if (!settings.sumit_company_id || !settings.sumit_api_key) {
    return { url: "", price, error: "sumit not configured" };
  }
  try {
    const itemName = isVip
      ? `צייד טיסות VIP - ${request.id.slice(0, 8)}`
      : `צייד טיסות - ${request.id.slice(0, 8)}`;
    const description = isVip
      ? `VIP — ${request.name}`
      : `${request.from_iata} > ${request.to_iata}`;

    const resp = await fetchWithTimeout("https://api.sumit.co.il/billing/payments/beginredirect/", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      timeoutMs: 12_000,
      body: JSON.stringify({
        Credentials: {
          CompanyID: parseInt(settings.sumit_company_id),
          APIKey: settings.sumit_api_key,
        },
        Customer: {
          Name: request.name,
          Phone: normalizeIsraeliPhone(request.whatsapp),
          EmailAddress: request.email || "",
        },
        Items: [{
          Item: { Name: itemName, Price: price, Currency: "ILS" },
          Quantity: 1,
          UnitPrice: price,
          Description: description,
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
    const url = data.RedirectURL || data.Data?.RedirectURL || "";
    if (!url) return { url: "", price, error: `sumit response missing url: ${JSON.stringify(data).slice(0, 200)}` };
    return { url, price };
  } catch (e) {
    logError("sumit.create", e, { request_id: request.id });
    return { url: "", price, error: String(e) };
  }
}

// =============================================================
// Send teaser + payment link to customer (or auto-pay in test mode)
// =============================================================

async function sendTeaserWithPayment(sb: any, settings: any, request: any, teaser: string) {
  const isVip = request.type === "vip";
  const price = isVip ? (settings.vip_price || "399") : (settings.service_price || "249");
  const testMode = settings.test_mode === "true";

  const disclaimers =
    `\n\n⚠️ *שים לב:*\n` +
    `• המחירים נכונים לרגע החיפוש ועשויים להשתנות\n` +
    `• אנחנו מאתרים טיסות — ההזמנה מתבצעת ישירות מול חברת התעופה או אתר ההזמנות\n` +
    `• המחירים כוללים מס ועמלות ידועות אך עלולים להשתנות בעת ההזמנה\n` +
    `• כבודה, בחירת מושב ותוספות נוספות עשויים להיות בתשלום נפרד\n`;

  // ---- TEST MODE: send teaser, mark paid, trigger handle-payment ----
  if (testMode) {
    const msg =
      `שלום ${request.name} 👋\n\n` +
      teaser + disclaimers +
      `\n🧪 *מצב טסט* — תשלום אוטומטי\n_צייד טיסות ✈️_`;
    await sendWhatsApp(settings, request.whatsapp, msg);

    await sb.from("requests").update({
      status: "paid",
      payment_id: "TEST_MODE",
      amount_paid: parseInt(price),
      paid_at: new Date().toISOString(),
    }).eq("id", request.id);

    try {
      await fetchWithTimeout(`${SB_URL}/functions/v1/handle-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_PUBLISHABLE}` },
        body: JSON.stringify({ request_id: request.id, payment_id: "TEST_MODE", amount: parseInt(price) }),
        timeoutMs: 30_000,
      });
    } catch (e) {
      logError("test_mode.handle_payment_trigger", e, { request_id: request.id });
    }
    return;
  }

  // ---- PRODUCTION: build payment link, send teaser+link ----
  const { url: paymentUrl, error: payErr } = await createPaymentLink(settings, request);
  let msg = `שלום ${request.name} 👋\n\n`;
  msg += teaser;
  msg += disclaimers;
  msg += `\n💳 *לתשלום ₪${price} וקבלת הפרטים המלאים:*\n`;
  if (paymentUrl) {
    msg += `${paymentUrl}\n`;
  } else {
    msg += `⚠️ לא הצלחנו ליצור קישור תשלום. צור קשר איתנו ונסדר ידנית.\n`;
  }
  msg += `\n_צייד טיסות ✈️_`;

  const sendRes = await sendWhatsApp(settings, request.whatsapp, msg);
  if (!sendRes.ok) logError("teaser.send", sendRes.error, { request_id: request.id });

  await sb.from("requests").update({
    status: "awaiting_payment",
    sent_at: new Date().toISOString(),
    admin_notes: payErr ? `payment link error: ${payErr}` : null,
  }).eq("id", request.id);
}

// =============================================================
// Anthropic Managed Agents — VIP analysis (with Messages API fallback)
// =============================================================

async function runVipAnalysis(
  settings: any,
  userPrompt: string
): Promise<{ analysis: string; source: string; error?: string }> {
  let lastError: string | undefined;

  // ---- Try Managed Agents first ----
  if (settings.claude_key && settings.managed_agent_id && settings.managed_env_id) {
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": settings.claude_key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": MANAGED_AGENTS_BETA,
      };
      const sessResp = await fetchWithTimeout("https://api.anthropic.com/v1/sessions", {
        method: "POST", headers, timeoutMs: 10_000,
        body: JSON.stringify({ agent: settings.managed_agent_id, environment_id: settings.managed_env_id }),
      });
      const sessData = await sessResp.json();
      const sessionId = sessData.id;
      if (!sessionId) throw new Error(`no session id: ${JSON.stringify(sessData).slice(0, 200)}`);

      await fetchWithTimeout(`https://api.anthropic.com/v1/sessions/${sessionId}/events`, {
        method: "POST", headers, timeoutMs: 10_000,
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: userPrompt }] }] }),
      });

      const deadline = Date.now() + MANAGED_AGENTS_DEADLINE_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, MANAGED_AGENTS_POLL_MS));
        const ev = await fetchWithTimeout(`https://api.anthropic.com/v1/sessions/${sessionId}/events`, {
          headers, timeoutMs: 5_000,
        });
        const evData = await ev.json();
        const events = evData.data || [];
        // Surface session-level errors (e.g. billing) before declaring success
        const sessionErr = events.find((e: any) => e.type === "session.error");
        if (sessionErr) {
          lastError = `agent: ${sessionErr.error?.type || "error"}: ${(sessionErr.error?.message || "").slice(0, 200)}`;
          break;
        }
        const idle = events.some((e: any) => e.type === "session.status_idle");
        if (idle) {
          const stopEvt = [...events].reverse().find((e: any) => e.type === "session.status_idle");
          const stopReason = stopEvt?.stop_reason?.type || "";
          if (stopReason && stopReason !== "end_turn") {
            lastError = `agent stopped: ${stopReason}`;
          }
          const agentMsg = [...events].reverse().find((e: any) => e.type === "agent.message");
          if (agentMsg) {
            const text = (agentMsg.content || []).map((c: any) => c.text || "").join("\n").trim();
            if (text) return { analysis: text, source: "managed-agent" };
          }
          break;
        }
      }
      if (!lastError) lastError = "managed agents: timeout waiting for idle";
    } catch (e) {
      lastError = `managed agents: ${e instanceof Error ? e.message : String(e)}`;
      logError("managed_agents", e);
    }
  }

  // ---- Fallback: Messages API ----
  if (settings.claude_key) {
    try {
      const aiResp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.claude_key,
          "anthropic-version": "2023-06-01",
        },
        timeoutMs: 25_000,
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
          system: `אתה עוזר של שירות איתור טיסות ישראלי בשם "צייד טיסות". אנחנו עוסקים אך ורק בטיסות. לא מלונות, לא השכרת רכב, לא חבילות נופש — רק טיסות.\n\nענה בעברית בפורמט הבא בדיוק (ללא markdown):\n\nסיכום:\n[משפט אחד]\n\nפרטים שזוהו:\n• מוצא: ...\n• יעד: ...\n• תאריכים: ...\n• הלוך/הלוך ושוב: ...\n• נוסעים: ...\n• תקציב: ...\n• מחלקה: ...\n• העדפות: ...\n• הערות: ...\n\nמשימות לסוכן:\n1. ...\n2. ...\n\nמידע חסר (לברר עם הלקוח):\n• ...`,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      const aiData = await aiResp.json();
      const text = aiData.content?.[0]?.text || "";
      if (text) return { analysis: text, source: "messages-api" };
      const apiErr = aiData.error;
      if (apiErr) {
        lastError = `messages api: ${apiErr.type || ""}: ${(apiErr.message || "").slice(0, 200)}`;
      } else {
        lastError = lastError || "messages api: empty response";
      }
      logError("messages_api.empty", new Error(lastError), { resp: JSON.stringify(aiData).slice(0, 300) });
    } catch (e) {
      lastError = `messages api: ${e instanceof Error ? e.message : String(e)}`;
      logError("messages_api", e);
    }
  }

  return {
    analysis: "⚠️ ניתוח AI לא זמין כרגע — סוכן אישי יחזור אליך.",
    source: "",
    error: lastError,
  };
}

// =============================================================
// Flight engines
// =============================================================

interface FlightResult {
  source: string;
  price_usd: number;
  airline: string;
  stops: number;
  duration_minutes: number;
  departure_time: string;
  arrival_time: string;
  departure_airport: string;
  arrival_airport: string;
  is_virtual_interline?: boolean;
  booking_token?: string | null;
  booking_url?: string | null;
  layovers?: any[];
  flights_detail?: any[];
}

async function searchSerpApi(
  settings: any, request: any, from: string, to: string, date: string
): Promise<FlightResult[]> {
  if (!settings.serpapi_key) return [];
  const out: FlightResult[] = [];
  try {
    const params = new URLSearchParams({
      engine: "google_flights",
      departure_id: from,
      arrival_id: to,
      outbound_date: date,
      type: "2", // one-way
      adults: String(request.adults || 1),
      children: String(request.children || 0),
      currency: "USD",
      api_key: settings.serpapi_key,
    });
    const resp = await fetchWithTimeout(`https://serpapi.com/search.json?${params}`, {
      timeoutMs: SERPAPI_TIMEOUT_MS,
    });
    if (!resp.ok) {
      logError("serpapi.http", `${resp.status}`, { from, to, date });
      return out;
    }
    const data = await resp.json();
    const flights = [...(data.best_flights || []), ...(data.other_flights || [])];
    for (const flight of flights.slice(0, 6)) {
      const firstLeg = flight.flights?.[0];
      const lastLeg = flight.flights?.[flight.flights?.length - 1];
      const airline = firstLeg?.airline || "";
      if (!airline || airline === "Unknown") continue;
      const cls = (firstLeg?.travel_class || "").toLowerCase();
      if (cls.includes("business") || cls.includes("first") || cls.includes("premium")) continue;
      out.push({
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
    logError("serpapi", e, { from, to, date });
  }
  return out;
}

async function searchSkyscanner(
  settings: any, request: any, from: string, to: string, date: string
): Promise<FlightResult[]> {
  if (!settings.skyfare_key) return [];
  const out: FlightResult[] = [];
  try {
    const qs = new URLSearchParams({
      fromEntityId: from,
      toEntityId: to,
      departDate: date,
      adults: String(request.adults || 1),
      currency: "USD",
    }).toString();
    const resp = await fetchWithTimeout(
      `https://flights-sky.p.rapidapi.com/flights/search-one-way?${qs}`,
      {
        headers: {
          "X-RapidAPI-Key": settings.skyfare_key,
          "X-RapidAPI-Host": "flights-sky.p.rapidapi.com",
        },
        timeoutMs: SKYSCANNER_TIMEOUT_MS,
      }
    );
    if (!resp.ok) {
      logError("skyscanner.http", `${resp.status}`, { from, to, date });
      return out;
    }
    const data = await resp.json();
    const itineraries = data.data?.itineraries || [];
    for (const itin of itineraries.slice(0, 6)) {
      const firstLeg = itin.legs?.[0];
      if (!firstLeg) continue;
      const airline = firstLeg.carriers?.marketing?.[0]?.name || "";
      if (!airline || airline === "Unknown") continue;
      out.push({
        source: "Skyscanner",
        price_usd: Math.round(itin.price?.raw || 0),
        airline,
        stops: firstLeg.stopCount || 0,
        duration_minutes: firstLeg.durationInMinutes || 0,
        departure_time: firstLeg.departure || "",
        arrival_time: firstLeg.arrival || "",
        departure_airport: firstLeg.origin?.name || "",
        arrival_airport: firstLeg.destination?.name || "",
        booking_url: null,
        flights_detail: (firstLeg.segments || []).map((s: any) => ({
          airline: s.operatingCarrier?.name || firstLeg.carriers?.marketing?.[0]?.name,
          flight_number: s.flightNumber || "",
          departure: { id: s.origin?.flightPlaceId, name: s.origin?.name, time: s.departure },
          arrival: { id: s.destination?.flightPlaceId, name: s.destination?.name, time: s.arrival },
          duration: s.durationInMinutes,
        })),
      });
    }
  } catch (e) {
    logError("skyscanner", e, { from, to, date });
  }
  return out;
}

async function searchKiwi(
  settings: any, request: any, from: string, to: string, date: string
): Promise<FlightResult[]> {
  if (!settings.skyfare_key) return [];
  const out: FlightResult[] = [];
  try {
    const adults = String(request.adults || 1);
    const children = String(request.children || 0);
    const totalPax = (request.adults || 1) + (request.children || 0);
    const params: Record<string, string> = {
      source: `City:${from}`,
      destination: `City:${to}`,
      outboundDepartureDateStart: `${date}T00:00:00`,
      outboundDepartureDateEnd: `${date}T23:59:59`,
      currency: "usd",
      locale: "en",
      adults,
      children,
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
    const resp = await fetchWithTimeout(
      `https://kiwi-com-cheap-flights.p.rapidapi.com/one-way?${new URLSearchParams(params)}`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": settings.skyfare_key,
          "X-RapidAPI-Host": "kiwi-com-cheap-flights.p.rapidapi.com",
        },
        timeoutMs: KIWI_TIMEOUT_MS,
      }
    );
    if (!resp.ok) {
      logError("kiwi.http", `${resp.status}`, { from, to, date });
      return out;
    }
    const data = await resp.json();
    const itineraries = data.itineraries || [];
    for (const itin of itineraries.slice(0, 6)) {
      const sectorObj = itin.sector || itin.outbound || {};
      const segs = sectorObj.sectorSegments || [];
      if (segs.length === 0) continue;
      const firstSeg = segs[0]?.segment || {};
      const lastSeg = segs[segs.length - 1]?.segment || firstSeg;
      const pricePerPerson = parseFloat(itin.price?.amount || "0");
      // When adults>1 some Kiwi responses already include the multiplier; fall back to
      // multiplying ourselves only when amount looks per-pax (heuristic: < $5k).
      const priceUsd = pricePerPerson < 5000 ? pricePerPerson * totalPax : pricePerPerson;
      const durationSec = sectorObj.duration || 0;

      const segAirlines = segs.map((ss: any) => ss.segment?.carrier?.name).filter(Boolean);
      const uniqueAirlines = [...new Set(segAirlines)];
      const isVI = uniqueAirlines.length > 1;
      const airline = isVI ? uniqueAirlines.join(" + ") : (firstSeg.carrier?.name || "");
      if (!airline) continue;

      out.push({
        source: "Kiwi.com",
        price_usd: Math.round(priceUsd),
        airline,
        is_virtual_interline: isVI,
        stops: Math.max(0, segs.length - 1),
        duration_minutes: Math.round(durationSec / 60),
        departure_time: firstSeg.source?.localTime || "",
        arrival_time: lastSeg.destination?.localTime || "",
        departure_airport: firstSeg.source?.station?.name || "",
        arrival_airport: lastSeg.destination?.station?.name || "",
        booking_url: null,
        flights_detail: segs.map((ss: any) => {
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
  } catch (e) {
    logError("kiwi", e, { from, to, date });
  }
  return out;
}

// =============================================================
// Result processing
// =============================================================

function deduplicateAndSort(rawResults: FlightResult[]): FlightResult[] {
  const dedupMap = new Map<string, FlightResult>();
  for (const r of rawResults) {
    const durBucket = Math.round((r.duration_minutes || 0) / 15) * 15;
    const key = `${r.airline}|${r.stops}|${durBucket}`;
    const existing = dedupMap.get(key);
    if (!existing || r.price_usd < existing.price_usd) dedupMap.set(key, r);
  }
  const deduped = Array.from(dedupMap.values());
  deduped.sort((a, b) => {
    if (a.stops === 0 && b.stops > 0) return -1;
    if (a.stops > 0 && b.stops === 0) return 1;
    return (a.price_usd || 9999) - (b.price_usd || 9999);
  });
  // Only keep connections cheaper than cheapest direct, EXCEPT preserve Kiwi virtual interlines
  const cheapestDirectPrice = deduped.find((r) => r.stops === 0)?.price_usd;
  if (cheapestDirectPrice) {
    return deduped.filter((r) =>
      r.stops === 0 ||
      r.price_usd < cheapestDirectPrice ||
      r.is_virtual_interline === true
    );
  }
  return deduped;
}

const fmtDur = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

function fmtFlight(r: FlightResult, idx: number): string {
  let line = `${idx}. *$${r.price_usd}* — ${r.airline}`;
  line += ` | ${r.stops === 0 ? "ישירה" : r.stops + " עצירות"}`;
  if (r.is_virtual_interline) line += ` 🔀 (חיבור עצמאי)`;
  if (r.duration_minutes) line += ` | ${fmtDur(r.duration_minutes)} שעות`;
  line += `\n`;
  if (r.departure_time) {
    const dep = r.departure_time?.slice?.(11, 16) || r.departure_time;
    const arr = r.arrival_time?.slice?.(11, 16) || r.arrival_time;
    line += `   🕐 ${dep}${arr ? " → " + arr : ""} | מקור: ${r.source}\n`;
  } else {
    line += `   מקור: ${r.source}\n`;
  }
  return line;
}

function buildDirectionSummary(deduped: FlightResult[], dirLabel: string, fromIata: string, toIata: string, date: string) {
  let admin = "", full = "", teaser = "";
  const directs = deduped.filter((r) => r.stops === 0);
  const conns = deduped.filter((r) => r.stops > 0);
  const top3 = directs.slice(0, 3);
  const cheapestConn = conns[0];
  const header = `\n✈️ *${dirLabel}: ${heCity(fromIata)} → ${heCity(toIata)}* (${date})\n\n`;

  // Admin
  admin += header;
  if (directs.length > 0) {
    admin += `🛫 *טיסות ישירות:*\n`;
    for (let i = 0; i < Math.min(5, directs.length); i++) admin += fmtFlight(directs[i], i + 1);
  }
  if (conns.length > 0) {
    admin += `\n🔗 *קונקשן (זול מישירה):*\n`;
    for (let i = 0; i < Math.min(3, conns.length); i++) {
      const r = conns[i];
      admin += fmtFlight(r, i + 1);
      if (r.flights_detail && r.flights_detail.length > 0) {
        for (let si = 0; si < r.flights_detail.length; si++) {
          const seg = r.flights_detail[si];
          admin += `     ${seg.airline} ${seg.flight_number || ""} | ${seg.departure?.id || ""} ${seg.departure?.time?.slice(11, 16) || ""} → ${seg.arrival?.id || ""} ${seg.arrival?.time?.slice(11, 16) || ""}`;
          if (seg.duration) admin += ` (${fmtDur(seg.duration)})`;
          admin += `\n`;
          if (si < r.flights_detail.length - 1) {
            const next = r.flights_detail[si + 1];
            const arrT = new Date(seg.arrival?.time || 0).getTime();
            const depT = new Date(next.departure?.time || 0).getTime();
            if (arrT && depT && depT > arrT) {
              const lay = Math.round((depT - arrT) / 60_000);
              admin += `     ⏳ המתנה: ${fmtDur(lay)} שעות\n`;
            }
          }
        }
      }
    }
  }
  if (deduped.length === 0) admin += `  ❌ לא נמצאו טיסות לכיוון זה\n`;

  // Full (post-payment)
  full += header;
  if (top3.length > 0) for (let i = 0; i < top3.length; i++) full += fmtFlight(top3[i], i + 1);
  if (cheapestConn) {
    const saving = top3.length > 0 ? top3[0].price_usd - cheapestConn.price_usd : 0;
    full += `\n💡 *קונקשן זול יותר: $${cheapestConn.price_usd}* — ${cheapestConn.airline}\n`;
    full += `   ${cheapestConn.stops} עצירות | ${fmtDur(cheapestConn.duration_minutes)} שעות`;
    if (saving > 0) full += ` | חיסכון $${saving} לעומת ישירה`;
    full += `\n   מקור: ${cheapestConn.source}\n`;
  }
  if (deduped.length === 0) full += `❌ לא נמצאו טיסות לכיוון זה\n`;

  // Teaser (pre-payment)
  teaser += `\n✈️ *${dirLabel}: ${heCity(fromIata)} → ${heCity(toIata)}* (${date})\n`;
  if (top3.length > 0) {
    teaser += `💰 מ-*$${top3[0].price_usd}* | ${directs.length} טיסות ישירות`;
    if (cheapestConn) teaser += ` + קונקשן מ-$${cheapestConn.price_usd}`;
    teaser += `\n`;
  } else if (cheapestConn) {
    teaser += `💰 מ-*$${cheapestConn.price_usd}* (קונקשן)\n`;
  } else {
    teaser += `❌ לא נמצאו טיסות\n`;
  }

  return { admin, full, teaser, cheapest: deduped[0]?.price_usd || null };
}

// =============================================================
// Admin approval handler (GET ?action=approve)
// =============================================================

async function handleApprove(sb: any, url: URL): Promise<Response> {
  const reqId = url.searchParams.get("request_id") || "";
  const confirmed = url.searchParams.get("confirm") === "yes";
  if (!reqId) return new Response("missing request_id", { status: 400, headers: corsHeaders });

  // Look up by full UUID, or by 8-char prefix (WhatsApp may break links at dashes in RTL)
  let r: any = null;
  if (reqId.length === 36) {
    const { data } = await sb.from("requests").select("*").eq("id", reqId).single();
    r = data;
  } else {
    const { data } = await sb.from("requests").select("*").order("created_at", { ascending: false }).limit(50);
    r = (data || []).find((row: any) => row.id?.startsWith(reqId));
  }
  if (!r) return jsonResponse({ error: "request not found" }, 404);

  if (r.status !== "found") {
    return htmlResponse(
      `<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>הבקשה כבר טופלה</h2><p>סטטוס: ${r.status}</p><p>בקשה: ${reqId.slice(0, 8)}</p>
      </body></html>`
    );
  }

  // Step 1: confirmation page (so WhatsApp link previews don't auto-trigger)
  if (!confirmed) {
    const confirmUrl = `${SB_URL}/functions/v1/search-flights?action=approve&request_id=${reqId}&confirm=yes`;
    const isVip = r.type === "vip";
    const routeInfo = isVip
      ? `<p><b>סוג:</b> 👑 VIP</p><p><b>בקשה:</b> ${(r.notes || "").slice(0, 200)}</p>`
      : `<p><b>מסלול:</b> ${r.from_iata} → ${r.to_iata}</p><p><b>תאריך:</b> ${r.depart_date}${r.return_date ? " — " + r.return_date : ""}</p>`;
    return htmlResponse(
      `<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#f0f0f5">
        <h2>✈️ צייד טיסות — אישור בקשה</h2>
        <p><b>לקוח:</b> ${r.name} (${r.whatsapp})</p>
        ${routeInfo}
        <br>
        <a href="${confirmUrl}" style="background:#22c55e;color:white;padding:15px 40px;border-radius:8px;text-decoration:none;font-size:18px">✅ אשר ושלח ללקוח</a>
        <br><br><p style="color:#888">לחץ על הכפתור לאישור</p>
      </body></html>`
    );
  }

  // Step 2: actually approve
  const { data: sData } = await sb.rpc("get_settings_json");
  const s = sData || {};
  const aiResp = r.ai_response || {};
  if (s.green_instance && s.green_token) {
    const teaser = aiResp.customer_teaser || "מצאנו תוצאות מעולות!";
    await sendTeaserWithPayment(sb, s, r, teaser);
  }

  return htmlResponse(
    `<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#f0f0f5">
      <h2>✅ הבקשה אושרה!</h2>
      <p>ההצעה נשלחה ללקוח <b>${r.name}</b> ב-WhatsApp.</p>
      <p>בקשה: ${reqId.slice(0, 8)}</p>
    </body></html>`
  );
}

// =============================================================
// Request validation
// =============================================================

function validateRequest(r: any, isVip: boolean): string | null {
  if (!r.name || r.name.length < 2) return "name required";
  if (!r.whatsapp || normalizeIsraeliPhone(r.whatsapp).length < 9) return "valid whatsapp required";
  if (!isValidEmail(r.email)) return "invalid email";
  if (isVip) return null; // VIP is free-text — skip route validation
  if (!isValidIATA(r.from_iata)) return "invalid from_iata";
  if (!isValidIATA(r.to_iata)) return "invalid to_iata";
  if (r.from_iata === r.to_iata) return "from and to must differ";
  if (!isValidISODate(r.depart_date)) return "invalid depart_date";
  if (!isFutureOrTodayDate(r.depart_date)) return "depart_date must be today or future";
  if (r.return_date && !isValidISODate(r.return_date)) return "invalid return_date";
  if (r.return_date && new Date(r.return_date) < new Date(r.depart_date)) return "return_date before depart_date";
  if ((r.adults || 1) < 1 || (r.adults || 1) > 9) return "adults must be 1-9";
  if ((r.children || 0) < 0 || (r.children || 0) > 9) return "children must be 0-9";
  return null;
}

// =============================================================
// VIP flow
// =============================================================

async function handleVip(sb: any, settings: any, request: any): Promise<Response> {
  const vipNotes = request.notes || "(ללא פרטים)";
  const vipPrice = settings.vip_price || "399";
  const userPrompt =
    `בקשת לקוח VIP:\n"${vipNotes}"\n\n` +
    `פרטי הלקוח:\nשם: ${request.name}\nטלפון: ${request.whatsapp}` +
    (request.email ? `\nאימייל: ${request.email}` : "") +
    `\n\nנתח לפי הפורמט המוגדר.`;

  const { analysis, source, error: aiError } = await runVipAnalysis(settings, userPrompt);

  const taskMatch = analysis.match(/משימות לסוכן:\s*\n([\s\S]*?)(?:\n\n|מידע חסר|$)/);
  const aiTasks = taskMatch
    ? taskMatch[1].split("\n").filter((l) => l.trim().match(/^\d+\./)).map((l) => l.trim())
    : [];

  const vipTeaser =
    `👑 *בקשת VIP — הצעה מותאמת אישית*\n\n` +
    `📝 *הבקשה שלך:*\n${vipNotes}\n\n` +
    `סוכן אישי בדק את הבקשה שלך ואישר אותה.\n` +
    `לאחר התשלום נשלח לך את כל הפרטים והמלצות הטיסה המלאות.`;

  const vipFull = analysis
    ? `\n👑 *ניתוח מותאם אישית:*\n${analysis}\n`
    : `\n⚠️ סוכן אישי ייצור איתך קשר עם הפרטים המלאים.\n`;

  await sb.from("requests").update({
    status: "found",
    admin_notes: aiError ? `AI error: ${aiError}` : null,
    ai_response: {
      type: "vip",
      raw_request: vipNotes,
      ai_analysis: analysis,
      ai_source: source,
      ai_error: aiError || null,
      ai_tasks: aiTasks,
      admin_summary: `👑 *בקשת VIP*\n\n${vipNotes}`,
      customer_teaser: vipTeaser,
      customer_full: vipFull,
      results: [],
    },
  }).eq("id", request.id);

  // Customer ack (immediate)
  const ackMsg =
    `שלום ${request.name} 👋\n\n` +
    `👑 *בקשת ה-VIP שלך התקבלה!*\n\n` +
    `סוכן אישי מנתח את הבקשה שלך כרגע ויחזור אליך בהקדם עם הצעה מותאמת אישית.\n\n` +
    `📋 מספר בקשה: ${request.id}\n_צייד טיסות ✈️_`;
  await sendWhatsApp(settings, request.whatsapp, ackMsg);

  // Admin notification + approval link
  if (settings.admin_whatsapp) {
    const approveUrl = `${SB_URL}/functions/v1/search-flights?action=approve&request_id=${request.id.slice(0, 8)}`;
    let adminMsg = `👑 *בקשת VIP חדשה!*\n\n`;
    adminMsg += `👤 *לקוח:* ${request.name} (${request.whatsapp})\n`;
    if (request.email) adminMsg += `📧 ${request.email}\n`;
    adminMsg += `\n📝 *הבקשה המקורית:*\n${vipNotes}\n`;
    if (analysis && source) {
      adminMsg += `\n🤖 *ניתוח AI (${source}):*\n${analysis}\n`;
    } else if (aiError) {
      adminMsg += `\n⚠️ *ניתוח AI נכשל:* ${aiError}\n` +
                  `(נדרש טיפול ידני — בדוק קרדיט / מפתח Anthropic)\n`;
    }
    adminMsg += `\n💰 מחיר VIP: ₪${vipPrice}\n📋 בקשה: ${request.id}\n\n`;
    adminMsg += `✅ *לאישור ושליחת קישור תשלום ללקוח:*\n${approveUrl}\n\n_צייד טיסות ✈️_`;
    await sendWhatsApp(settings, settings.admin_whatsapp, adminMsg);
  }

  return jsonResponse({ success: true, status: "found", type: "vip", ai_source: source });
}

// =============================================================
// Main entrypoint
// =============================================================

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = createClient(SB_URL, SB_PUBLISHABLE);
    const url = new URL(req.url);

    // GET ?action=approve — admin approval
    if (req.method === "GET" && url.searchParams.get("action") === "approve") {
      return await handleApprove(sb, url);
    }

    // POST — flight search
    const body = await req.json();
    const requestId = body.id;
    if (!requestId) return jsonResponse({ error: "missing request id" }, 400);

    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};

    const { data: request, error: reqErr } = await sb
      .from("requests").select("*").eq("id", requestId).single();
    if (reqErr || !request) return jsonResponse({ error: "request not found" }, 404);

    // Validate
    const isVip = request.type === "vip";
    const validationErr = validateRequest(request, isVip);
    if (validationErr) {
      await sb.from("requests").update({
        status: "failed", admin_notes: `validation: ${validationErr}`,
      }).eq("id", requestId);
      return jsonResponse({ error: validationErr }, 400);
    }

    await sb.from("requests").update({ status: "searching" }).eq("id", requestId);

    // Wrap remaining work so errors mark status=failed instead of leaving "searching" forever
    try {
      if (isVip) return await handleVip(sb, settings, request);

      // ---- Beat / Research search ----
      const isRoundTrip = !request.is_one_way && request.return_date;
      const directions = isRoundTrip
        ? [
            { from: request.from_iata, to: request.to_iata, date: request.depart_date, label: "הלוך" },
            { from: request.to_iata, to: request.from_iata, date: request.return_date, label: "חזור" },
          ]
        : [
            { from: request.from_iata, to: request.to_iata, date: request.depart_date, label: "הלוך" },
          ];

      const searchResults = await Promise.all(
        directions.map(async (dir) => {
          const [serp, sky, kiwi] = await Promise.all([
            searchSerpApi(settings, request, dir.from, dir.to, dir.date),
            searchSkyscanner(settings, request, dir.from, dir.to, dir.date),
            searchKiwi(settings, request, dir.from, dir.to, dir.date),
          ]);
          const raw = [...serp, ...sky, ...kiwi];
          return { dir, raw, deduped: deduplicateAndSort(raw) };
        })
      );

      const allRaw = searchResults.flatMap((d) => d.raw);
      const allDeduped = searchResults.flatMap((d) => d.deduped);

      const googleCount = allRaw.filter((r) => r.source === "Google Flights").length;
      const skyCount = allRaw.filter((r) => r.source === "Skyscanner").length;
      const kiwiCount = allRaw.filter((r) => r.source === "Kiwi.com").length;
      let engineStats = `🔎 *מנועי חיפוש:*\n`;
      if (settings.serpapi_key) engineStats += `  • Google Flights: ${googleCount > 0 ? googleCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
      if (settings.skyfare_key) engineStats += `  • Skyscanner: ${skyCount > 0 ? skyCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
      if (settings.skyfare_key) engineStats += `  • Kiwi.com: ${kiwiCount > 0 ? kiwiCount + " תוצאות" : "❌ ללא תוצאות"}\n`;
      if (!settings.serpapi_key && !settings.skyfare_key) engineStats += `  ⚠️ אין מפתחות API מוגדרים!\n`;
      const viCount = allDeduped.filter((r) => r.is_virtual_interline).length;
      if (viCount > 0) engineStats += `  🔗 קונקשנים חכמים (Virtual Interline): ${viCount}\n`;
      engineStats += `  📊 סה"כ: ${allDeduped.length} תוצאות ייחודיות (מתוך ${allRaw.length})\n`;

      const cheapest = allDeduped.length > 0 ? Math.min(...allDeduped.map((r) => r.price_usd)) : null;
      const isBeat = request.type === "beat";
      let status: "found" | "not_found" = "found";
      let adminSummary = "", customerTeaser = "";

      if (allDeduped.length === 0) {
        status = "not_found";
        adminSummary = `לא נמצאו תוצאות עבור החיפוש הזה.\n`;
        adminSummary += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        adminSummary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        adminSummary += engineStats;
        customerTeaser =
          `שלום ${request.name} 👋\n\n` +
          `לצערנו, לא הצלחנו למצוא טיסות עבור החיפוש שלך:\n\n` +
          `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` +
          `🔄 ${tripLabel(request)}\n` +
          `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n` +
          `💡 *טיפים לשיפור החיפוש:*\n` +
          `• נסה תאריכים גמישים יותר (±3 ימים)\n` +
          `• בדוק שדות תעופה חלופיים באותו אזור\n` +
          `• נסה לחפש הלוך בלבד במקום הלוך ושוב\n` +
          `• חפש בתקופה שונה — לפעמים שבוע קודם/אחר עושה הבדל גדול\n\n` +
          `רוצה לנסות שוב? פשוט שלח בקשה חדשה באתר 🔄\n` +
          `כמובן — *ללא חיוב* כי לא מצאנו.\n\n` +
          `📋 מספר בקשה: ${requestId}\n_צייד טיסות ✈️_`;
      } else if (isBeat) {
        const customerPrice = request.customer_price_usd || 0;
        const outboundCheapest = searchResults[0]?.deduped[0]?.price_usd;
        if (outboundCheapest && outboundCheapest < customerPrice) {
          const saving = customerPrice - outboundCheapest;
          const savingPct = Math.round((saving / customerPrice) * 100);
          adminSummary = `🎉 מצאנו טיסה זולה יותר!\n\n`;
          adminSummary += `המחיר של הלקוח: $${customerPrice}\n`;
          adminSummary += `המחיר שמצאנו (הלוך): $${outboundCheapest}\n`;
          adminSummary += `חיסכון: $${saving} (${savingPct}%)\n`;
          for (const dr of searchResults) adminSummary += buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date).admin;
          adminSummary += `\n${engineStats}`;

          customerTeaser = `🎉 חדשות מעולות!\n\n`;
          customerTeaser += `מצאנו טיסה ב-*$${outboundCheapest}* במקום $${customerPrice} שמצאת!\n`;
          customerTeaser += `💰 חיסכון של *$${saving}* (${savingPct}%)\n`;
          if (isRoundTrip) {
            customerTeaser += `\n🔄 *הלוך ושוב — הצעות לכל כיוון בנפרד:*\n`;
            for (const dr of searchResults) customerTeaser += buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date).teaser;
          }
          customerTeaser += `\nלקבלת כל הפרטים המלאים (חברה, שעות, מקור) — אשר תשלום.\n\n📋 מספר בקשה: ${requestId}`;
        } else {
          status = "not_found";
          adminSummary = `לא מצאנו מחיר זול יותר מ-$${customerPrice}.\nהמחיר הזול ביותר שמצאנו: $${outboundCheapest || cheapest}\nייתכן שהמחיר שמצא הלקוח הוא כבר הדיל הכי טוב.\n\n${engineStats}`;
          customerTeaser =
            `שלום ${request.name} 👋\n\n` +
            `חיפשנו עבורך טיסה זולה יותר מ-*$${customerPrice}* שמצאת:\n\n` +
            `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` +
            `🔄 ${tripLabel(request)}\n` +
            `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n` +
            `לצערנו, המחיר שמצאת הוא כבר מצוין — לא הצלחנו להכות אותו! 👏\n` +
            `המחיר הזול ביותר שמצאנו: *$${outboundCheapest || cheapest}*\n\n` +
            `💡 *טיפים שיכולים לעזור:*\n` +
            `• נסה תאריכים גמישים (±3 ימים) — הפרשים יכולים להגיע ל-30%\n` +
            `• בדוק שדה תעופה חלופי\n` +
            `• נסה טיסה עם עצירה — לפעמים זול משמעותית\n` +
            `• הזמן מוקדם — מחירים עולים ככל שמתקרבים לתאריך\n\n` +
            `רוצה לנסות שוב עם פרמטרים אחרים? שלח בקשה חדשה 🔄\n` +
            `כמובן — *ללא חיוב* כי לא הכינו את המחיר.\n\n` +
            `📋 מספר בקשה: ${requestId}\n_צייד טיסות ✈️_`;
        }
      } else {
        // Research
        adminSummary = `📊 דוח מחקר טיסות\n`;
        adminSummary += `${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        adminSummary += `🔄 ${tripLabel(request)}\n`;
        adminSummary += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
        adminSummary += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n`;
        for (const dr of searchResults) adminSummary += buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date).admin;
        adminSummary += `\n${engineStats}`;

        customerTeaser =
          `📊 הדוח שלך מוכן!\n\n` +
          `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` +
          `🔄 ${tripLabel(request)}\n` +
          `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n`;
        if (isRoundTrip) customerTeaser += `🔄 *הצעות לכל כיוון בנפרד:*\n`;
        for (const dr of searchResults) customerTeaser += buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date).teaser;
        customerTeaser += `\nלקבלת הדוח המלא עם חברות, שעות ומקורות — אשר תשלום.\n\n📋 מספר בקשה: ${requestId}`;
      }

      // Build full customer message (post-payment)
      let customerFull = "";
      if (allDeduped.length > 0) {
        for (const dr of searchResults) customerFull += buildDirectionSummary(dr.deduped, dr.dir.label, dr.dir.from, dr.dir.to, dr.dir.date).full;
        customerFull += `\n🔗 *חפש והזמן ב:*\n• Google Flights: google.com/travel/flights\n• Skyscanner: skyscanner.com\n• Kiwi.com: kiwi.com\n`;
      }

      const aiResponse = {
        admin_summary: adminSummary,
        customer_teaser: customerTeaser,
        customer_full: customerFull,
        results: allDeduped.slice(0, 10),
        direction_results: searchResults.map((dr) => ({
          label: dr.dir.label, from: dr.dir.from, to: dr.dir.to, date: dr.dir.date,
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

      await sb.from("requests").update({
        ai_response: aiResponse, cheapest_found: cheapest, status,
      }).eq("id", requestId);

      const adminApproval = settings.admin_approval === "true";
      const approveUrl = `${SB_URL}/functions/v1/search-flights?action=approve&request_id=${requestId.slice(0, 8)}`;

      // Not-found: send tips to customer + admin notification
      if (status === "not_found" && settings.green_instance && settings.green_token) {
        await sendWhatsApp(settings, request.whatsapp, customerTeaser);
        if (settings.admin_whatsapp) {
          const adminMsg =
            `⚠️ *חיפוש ללא תוצאות*\n\n` +
            `👤 ${request.name} (${request.whatsapp})\n` +
            `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` +
            `🔄 ${tripLabel(request)}\n` +
            `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n` +
            adminSummary +
            `\n\n_הלקוח קיבל הודעה עם טיפים לשיפור החיפוש._\n_צייד טיסות ✈️_`;
          await sendWhatsApp(settings, settings.admin_whatsapp, adminMsg);
        }
      }

      // Admin approval flow
      if (adminApproval && status === "found" && settings.admin_whatsapp) {
        let adminMsg = `🔔 *בקשה חדשה מחכה לאישורך!*\n\n`;
        adminMsg += `👤 ${request.name} (${request.whatsapp})\n`;
        adminMsg += `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n`;
        adminMsg += `🔄 ${tripLabel(request)}\n`;
        adminMsg += `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n`;
        adminMsg += `👥 ${request.adults} מבוגרים${request.children ? " + " + request.children + " ילדים" : ""}\n`;
        if (isBeat) adminMsg += `💰 המחיר של הלקוח: $${request.customer_price_usd}${request.customer_price_source ? " (" + request.customer_price_source + ")" : ""}\n`;
        adminMsg += `\n${adminSummary}`;
        adminMsg += `\n\n✅ *לאישור ושליחה ללקוח — לחץ כאן:*\n${approveUrl}\n\n_צייד טיסות ✈️_`;
        await sendWhatsApp(settings, settings.admin_whatsapp, adminMsg);
      } else if (status === "found" && settings.green_instance && settings.green_token) {
        await sendTeaserWithPayment(sb, settings, request, customerTeaser);
      }

      return jsonResponse({ success: true, status, results_count: allDeduped.length });
    } catch (innerErr) {
      logError("search.inner", innerErr, { request_id: requestId });
      await sb.from("requests").update({
        status: "failed", admin_notes: `error: ${String(innerErr).slice(0, 500)}`,
      }).eq("id", requestId);
      return jsonResponse({ error: String(innerErr) }, 500);
    }
  } catch (err) {
    logError("search.outer", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
