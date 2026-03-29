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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(SB_URL, SB_KEY);
    const body = await req.json();

    // Green API webhook sends: typeWebhook, senderData, messageData
    // Extract phone number and message text
    const senderPhone =
      body.senderData?.sender?.replace("@c.us", "") ||
      body.phone ||
      body.from ||
      "";
    const messageText =
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text ||
      body.text ||
      body.message ||
      "";

    // Check if the reply is "כן" or "yes"
    const normalizedMsg = messageText.trim().toLowerCase();
    const isYes =
      normalizedMsg === "כן" ||
      normalizedMsg === "yes" ||
      normalizedMsg === "כ" ||
      normalizedMsg === "1";

    if (!isYes) {
      return new Response(
        JSON.stringify({ success: true, action: "ignored", reason: "not a yes reply" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normalize phone — remove 972 prefix to match DB format (stored as 05xxxxxxxx)
    const phoneDigits = senderPhone.replace(/[^0-9]/g, "");
    // Try to find the request by WhatsApp number
    // DB stores as "05xxxxxxxx", Green API sends as "972xxxxxxxxx"
    let whatsappSearch = phoneDigits;
    if (phoneDigits.startsWith("972")) {
      whatsappSearch = "0" + phoneDigits.slice(3);
    }

    // Find the most recent request with status sent_price for this phone
    const { data: requests } = await sb
      .from("requests")
      .select("*")
      .eq("whatsapp", whatsappSearch)
      .eq("status", "sent_price")
      .order("created_at", { ascending: false })
      .limit(1);

    // Also try without leading 0
    let request = requests?.[0];
    if (!request) {
      const altPhone = whatsappSearch.replace(/^0/, "");
      const { data: altRequests } = await sb
        .from("requests")
        .select("*")
        .like("whatsapp", `%${altPhone}`)
        .eq("status", "sent_price")
        .order("created_at", { ascending: false })
        .limit(1);
      request = altRequests?.[0];
    }

    if (!request) {
      return new Response(
        JSON.stringify({ success: false, error: "no matching request found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Load settings for SUMIT + Green API
    const { data: settingsData } = await sb.rpc("get_settings_json");
    const settings = settingsData || {};

    const servicePrice = parseInt(settings.service_price || "249");
    const testMode = settings.test_mode === "true";
    const chatId = `${phoneDigits.startsWith("972") ? phoneDigits : "972" + phoneDigits.replace(/^0/, "")}@c.us`;

    // TEST MODE — skip SUMIT, simulate payment
    if (testMode) {
      await sb
        .from("requests")
        .update({
          status: "paid",
          payment_id: "TEST_MODE",
          amount_paid: servicePrice,
          paid_at: new Date().toISOString(),
        })
        .eq("id", request.id);

      // Trigger handle-payment flow — send full details via WhatsApp
      try {
        await fetch(`${SB_URL}/functions/v1/handle-payment`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SB_KEY}`,
          },
          body: JSON.stringify({ request_id: request.id, payment_id: "TEST_MODE", amount: servicePrice }),
        });
      } catch (e) {
        console.error("Test mode handle-payment trigger error:", e);
      }

      return new Response(
        JSON.stringify({ success: true, request_id: request.id, test_mode: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // PRODUCTION MODE — create SUMIT payment link
    let paymentUrl = "";
    if (settings.sumit_company_id && settings.sumit_api_key) {
      try {
        const sumitResp = await fetch("https://api.sumit.co.il/billing/payments/beginredirect/", {
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
            Items: [
              {
                Item: {
                  Name: `tsayad hateisot - ${request.id.slice(0, 8)}`,
                  Price: servicePrice,
                  Currency: "ILS",
                },
                Quantity: 1,
                UnitPrice: servicePrice,
                Description: `${request.from_iata} > ${request.to_iata}`,
              },
            ],
            VATIncluded: true,
            RedirectURL: `${SB_URL}/functions/v1/handle-payment?request_id=${request.id}`,
            ExternalIdentifier: request.id,
            MaximumPayments: 1,
            SendUpdateByEmailAddress: request.email || "",
            ExpirationHours: 48,
          }),
        });
        const sumitData = await sumitResp.json();
        paymentUrl = sumitData.RedirectURL || sumitData.Data?.RedirectURL || "";
      } catch (e) {
        console.error("SUMIT error:", e);
      }
    }

    // Update request status
    await sb
      .from("requests")
      .update({ status: "awaiting_payment" })
      .eq("id", request.id);

    // Send payment link via WhatsApp
    if (settings.green_instance && settings.green_token && paymentUrl) {
      const msg =
        `שלום ${request.name} 👋\n\n` +
        `מעולה! הנה קישור התשלום שלך:\n\n` +
        `💳 ${paymentUrl}\n\n` +
        `סכום: ₪${servicePrice}\n` +
        `✈️ ${heCity(request.from_iata)} → ${heCity(request.to_iata)}\n` +
        `🔄 ${request.is_one_way ? 'הלוך בלבד' : 'הלוך ושוב'}\n` +
        `📅 ${request.depart_date}${request.return_date ? " — " + request.return_date : ""}\n\n` +
        `ברגע שהתשלום יאושר — נשלח לך את כל הפרטים המלאים! 🎉\n\n` +
        `📋 מספר בקשה: ${request.id}\n` +
        `_צייד טיסות ✈️_`;

      try {
        await fetch(
          `https://api.green-api.com/waInstance${settings.green_instance}/sendMessage/${settings.green_token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId, message: msg }),
          }
        );
      } catch (e) {
        console.error("WhatsApp send error:", e);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        request_id: request.id,
        payment_url: paymentUrl,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("handle-reply error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
