const https = require('https');

const TOKEN = '96728dd1-e63c-4aab-b383-1758b43d2f50';

function createScenario(name, desc, blueprint) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      teamId: 85956,
      name: name,
      description: desc,
      concept: false,
      folderId: 491639,
      blueprint: JSON.stringify(blueprint),
      scheduling: JSON.stringify({type:'indefinitely', interval:900})
    });
    const req = https.request({
      hostname: 'eu2.make.com',
      path: '/api/v2/scenarios',
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve({message: d}); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const s1 = {
  name: 'Flight Hunter - Search',
  flow: [
    {
      id: 1, module: 'gateway:CustomWebHook', version: 1,
      parameters: { hook: 4000231, maxResults: 1 },
      mapper: {},
      metadata: { designer: { x: 0, y: 0 } }
    },
    {
      id: 2, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://serpapi.com/search',
        method: 'get',
        qs: [
          {name:'engine',value:'google_flights'},
          {name:'departure_id',value:'{{1.from_iata}}'},
          {name:'arrival_id',value:'{{1.to_iata}}'},
          {name:'outbound_date',value:'{{1.depart_date}}'},
          {name:'return_date',value:'{{1.return_date}}'},
          {name:'adults',value:'{{1.adults}}'},
          {name:'currency',value:'USD'},
          {name:'hl',value:'he'},
          {name:'gl',value:'il'},
          {name:'api_key',value:'SERPAPI_KEY_HERE'}
        ],
        bodyType:'raw', parseResponse:true, serializeUrl:false
      },
      metadata: { designer: { x: 350, y: -200 } }
    },
    {
      id: 3, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.tequila.kiwi.com/v2/search',
        method: 'get',
        qs: [
          {name:'fly_from',value:'{{1.from_iata}}'},
          {name:'fly_to',value:'{{1.to_iata}}'},
          {name:'date_from',value:'{{1.depart_date}}'},
          {name:'date_to',value:'{{1.depart_date}}'},
          {name:'return_from',value:'{{1.return_date}}'},
          {name:'return_to',value:'{{1.return_date}}'},
          {name:'adults',value:'{{1.adults}}'},
          {name:'curr',value:'USD'},
          {name:'limit',value:'10'},
          {name:'sort',value:'price'}
        ],
        headers: [{name:'apikey',value:'KIWI_KEY_HERE'}],
        bodyType:'raw', parseResponse:true, serializeUrl:false
      },
      metadata: { designer: { x: 350, y: 200 } }
    },
    {
      id: 4, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'post',
        headers: [
          {name:'x-api-key',value:'CLAUDE_KEY_HERE'},
          {name:'anthropic-version',value:'2023-06-01'},
          {name:'Content-Type',value:'application/json'}
        ],
        body: '{"model":"claude-sonnet-4-20250514","max_tokens":2000,"messages":[{"role":"user","content":"Analyze flight results. Route: {{1.from_iata}} to {{1.to_iata}}, {{1.depart_date}}-{{1.return_date}}, {{1.adults}} adults. Customer price: ${{1.customer_price_usd}}. Type: {{1.type}}. Google: {{2.data}}. Kiwi: {{3.data}}. Return JSON: {found:bool, cheapest_price:num, deals:[{rank,airline,price,duration,stops,source,booking_url,reason}], recommendation:text, tip:text}"}]}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 700, y: 0 } }
    },
    {
      id: 5, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://stncskqjrmecjckxldvi.supabase.co/rest/v1/requests',
        method: 'post',
        headers: [
          {name:'apikey',value:'sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Authorization',value:'Bearer sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Content-Type',value:'application/json'},
          {name:'Prefer',value:'return=representation'}
        ],
        body: '{"name":"{{1.name}}","whatsapp":"{{1.whatsapp}}","from_iata":"{{1.from_iata}}","to_iata":"{{1.to_iata}}","depart_date":"{{1.depart_date}}","return_date":"{{1.return_date}}","adults":{{1.adults}},"type":"{{1.type}}","customer_price_usd":{{1.customer_price_usd}},"status":"searching","ai_response":"{{4.data}}"}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 1000, y: 0 } }
    },
    {
      id: 6, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.green-api.com/waInstanceGREEN_INSTANCE/sendMessage/GREEN_TOKEN',
        method: 'post',
        headers: [{name:'Content-Type',value:'application/json'}],
        body: '{"chatId":"972{{1.whatsapp}}@c.us","message":"שלום {{1.name}} 👋\\n\\nצייד טיסות סיים לחפש עבורך.\\n\\n✈️ {{1.from_iata}} → {{1.to_iata}}\\n📅 {{1.depart_date}} — {{1.return_date}}\\n\\n🎯 מצאנו טיסות מעולות!\\n\\nרוצה לקבל את הפרטים המלאים?\\nתשלום חד-פעמי ₪249.\\n\\nהשב *כן* לקבלת קישור תשלום."}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 1300, y: 0 } }
    }
  ],
  metadata: {
    version: 1,
    scenario: { roundtrips:1, maxErrors:3, autoCommit:true, autoCommitTriggerLast:true, sequential:true, confidential:false, dataloss:false },
    designer: { orphans: [] }
  }
};

const s2 = {
  name: 'Flight Hunter - Customer Reply',
  flow: [
    {
      id: 1, module: 'gateway:CustomWebHook', version: 1,
      parameters: { hook: 4000233, maxResults: 1 },
      mapper: {},
      metadata: { designer: { x: 0, y: 0 } }
    },
    {
      id: 2, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://stncskqjrmecjckxldvi.supabase.co/rest/v1/requests?whatsapp=eq.{{1.senderData.chatId}}&status=eq.searching&order=created_at.desc&limit=1',
        method: 'get',
        headers: [
          {name:'apikey',value:'sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Authorization',value:'Bearer sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'}
        ],
        bodyType:'raw', parseResponse:true
      },
      metadata: { designer: { x: 350, y: 0 } }
    },
    {
      id: 3, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.sumit.co.il/billing/paymentrequest/create/',
        method: 'post',
        headers: [{name:'Content-Type',value:'application/json'}],
        body: '{"Company":{"CompanyID":"SUMIT_COMPANY_ID","APIKey":"SUMIT_API_KEY"},"Customer":{"Name":"{{2.data[].name}}","Phone":"{{2.data[].whatsapp}}"},"Items":[{"Item":{"Name":"צייד טיסות - דוח טיסות","Price":249,"Quantity":1}}],"RedirectURL":"https://hook.eu2.make.com/w8a4rxi989q71n5wqyo1xatyx55vttpv?request_id={{2.data[].id}}","SendEmail":false}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 700, y: 0 } }
    },
    {
      id: 4, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.green-api.com/waInstanceGREEN_INSTANCE/sendMessage/GREEN_TOKEN',
        method: 'post',
        headers: [{name:'Content-Type',value:'application/json'}],
        body: '{"chatId":"{{1.senderData.chatId}}","message":"מעולה! 🎉\\n\\nהנה קישור לתשלום מאובטח:\\n{{3.data.PaymentURL}}\\n\\n₪249 חד-פעמי — מקבלים דוח מלא עם כל הפרטים."}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 1000, y: 0 } }
    }
  ],
  metadata: {
    version: 1,
    scenario: { roundtrips:1, maxErrors:3, autoCommit:true, autoCommitTriggerLast:true, sequential:true, confidential:false, dataloss:false },
    designer: { orphans: [] }
  }
};

const s3 = {
  name: 'Flight Hunter - Payment Done',
  flow: [
    {
      id: 1, module: 'gateway:CustomWebHook', version: 1,
      parameters: { hook: 4000232, maxResults: 1 },
      mapper: {},
      metadata: { designer: { x: 0, y: 0 } }
    },
    {
      id: 2, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://stncskqjrmecjckxldvi.supabase.co/rest/v1/requests?id=eq.{{1.request_id}}',
        method: 'get',
        headers: [
          {name:'apikey',value:'sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Authorization',value:'Bearer sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'}
        ],
        bodyType:'raw', parseResponse:true
      },
      metadata: { designer: { x: 350, y: 0 } }
    },
    {
      id: 3, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://api.green-api.com/waInstanceGREEN_INSTANCE/sendMessage/GREEN_TOKEN',
        method: 'post',
        headers: [{name:'Content-Type',value:'application/json'}],
        body: '{"chatId":"972{{2.data[].whatsapp}}@c.us","message":"✈️ *הדוח שלך מוכן!*\\n\\nשלום {{2.data[].name}},\\n\\nהנה הפרטים המלאים:\\n\\n{{2.data[].ai_response}}\\n\\n🔗 להזמנה:\\nhttps://www.google.com/travel/flights\\n\\n💡 כדאי להזמין בהקדם!\\n\\n_צייד טיסות_"}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 700, y: 0 } }
    },
    {
      id: 4, module: 'http:ActionSendData', version: 3,
      parameters: {},
      mapper: {
        url: 'https://stncskqjrmecjckxldvi.supabase.co/rest/v1/requests?id=eq.{{1.request_id}}',
        method: 'patch',
        headers: [
          {name:'apikey',value:'sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Authorization',value:'Bearer sb_publishable_8MkxUO2bv-j-19qulr6Ong_UnVY915I'},
          {name:'Content-Type',value:'application/json'}
        ],
        body: '{"status":"sent","amount_paid":249}',
        bodyType:'raw', contentType:'application/json', parseResponse:true
      },
      metadata: { designer: { x: 1000, y: 0 } }
    }
  ],
  metadata: {
    version: 1,
    scenario: { roundtrips:1, maxErrors:3, autoCommit:true, autoCommitTriggerLast:true, sequential:true, confidential:false, dataloss:false },
    designer: { orphans: [] }
  }
};

async function main() {
  console.log('Creating Scenario 1: Flight Search...');
  const r1 = await createScenario('Flight Hunter - Search', 'Webhook > SerpApi + Kiwi > Claude AI > Supabase > WhatsApp', s1);
  console.log('S1:', r1.scenario ? 'OK id=' + r1.scenario.id : JSON.stringify(r1).slice(0,200));

  console.log('Creating Scenario 2: Customer Reply...');
  const r2 = await createScenario('Flight Hunter - Customer Reply', 'WhatsApp reply > Supabase lookup > SUMIT payment link > WhatsApp', s2);
  console.log('S2:', r2.scenario ? 'OK id=' + r2.scenario.id : JSON.stringify(r2).slice(0,200));

  console.log('Creating Scenario 3: Payment Done...');
  const r3 = await createScenario('Flight Hunter - Payment Done', 'SUMIT webhook > Supabase get > WhatsApp full details > Update status', s3);
  console.log('S3:', r3.scenario ? 'OK id=' + r3.scenario.id : JSON.stringify(r3).slice(0,200));
}

main().catch(e => console.error(e));
