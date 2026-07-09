# צייד טיסות ✈️ — מסמך איפיון מלא

> מאומת מול הקוד בפרודקשן: `f19595e` (2026-07-09).
> סימונים: ✅ מיושם ונבדק · ⚠️ פער ידוע · 🔒 החלטת אבטחה

---

## 1. המוצר

שירות ישראלי לאיתור טיסות זולות. הלקוח ממלא טופס באתר, המערכת סורקת
שלושה מנועי חיפוש במקביל, סוכן AI מנתח בקשות מורכבות, והתוצאות נשלחות
ב-WhatsApp — **בתשלום רק אם נמצאו תוצאות**.

### שלושה מסלולים

| מסלול | קלט | פלט | מחיר (settings) |
|---|---|---|---|
| **🎯 הכה את המחיר** (`beat`) | מסלול + מחיר שהלקוח כבר מצא | טיסה זולה יותר, או "לא הצלחנו" חינם | `service_price` (₪149 כרגע) |
| **📊 דוח מחקר** (`research`) | מסלול + תאריכים | דוח מלא: ישירות + קונקשנים מ-3 מקורות | `service_price` |
| **👑 VIP** (`vip`) | טקסט חופשי בעברית | ניתוח AI + טיפול אישי של סוכן אנושי | `vip_price` (₪399) |

---

## 2. ארכיטקטורה

```
לקוח (דפדפן)
   │  https://tmarchum.github.io/flight-hunter  (GitHub Pages, SPA יחיד index.html)
   ▼
Supabase (stncskqjrmecjckxldvi)
   ├─ Postgres: requests, settings (+RLS)
   ├─ RPC: get_settings_json (שרת), get_public_settings (אנונימי),
   │       get_admin_settings(pw), set_admin_setting(pw,k,v)
   └─ Edge Functions (Deno):
        ├─ search-flights   — חיפוש, VIP, אישור אדמין (GET approve)
        ├─ handle-payment   — SUMIT redirect/webhook → פרטים מלאים
        ├─ handle-reply     — webhook הודעות WhatsApp נכנסות
        └─ _shared/utils.ts — עזרי טלפון/HTTP/ולידציה/לוגים
   ▼
אינטגרציות: SerpApi (Google Flights) · RapidAPI (Skyscanner flights-sky,
Kiwi kiwi-com-cheap-flights) · Anthropic (Managed Agents + Messages) ·
SUMIT (סליקה) · Green API (WhatsApp, instance 7103871299)
```

- ✅ SPA טעון מ-Babel standalone **מקובע** ל-7.24.7 + `data-presets="env,react"`
  (גרסת latest שברה את האתר — JSX runtime אוטומטי).
- ✅ טוקנים/מפתחות לא מגיעים לדפדפן (מאז `f19595e`).

---

## 3. מסע לקוח — Beat / Research

1. **טופס באתר** (3 שלבים / 2 ל-beat): מסלול, תאריכים, נוסעים, העדפות, פרטי קשר.
   - ✅ טלפון מנורמל בטופס לפורמט `05XXXXXXXX` (מקבל גם +972 / 972 / רווחים / מקפים)
   - השורה נכתבת ל-`requests` עם `status='pending'`, ואז הטופס קורא ל-webhook `search-flights` עם `{id}` בלבד.
2. **search-flights**:
   a. ולידציה (IATA, תאריך עתידי, חזור≥הלוך, 1-9 נוסעים, אימייל) → כישלון: `status='failed'` + סיבה ב-`admin_notes` + HTTP 400 ✅
   b. `status='searching'` ✅
   c. **אישור קבלה מיידי ללקוח ב-WhatsApp** ("✅ הבקשה שלך התקבלה… מחפשים עכשיו") — נשלח מהשרת ✅
   d. חיפוש בכל הכיוונים במקביל (הלוך-ושוב = 2 חיפושי one-way נפרדים) ✅
   e. דדופ ומיון (ראה §5) ✅
   f. בניית שלושה מסמכים: `admin_summary` (מלא), `customer_teaser` (מחיר-פתיח בלבד), `customer_full` (מלא — נשלח רק אחרי תשלום) ✅
   g. `status='found'` או `'not_found'`
3. **לא נמצא** (`not_found`): הלקוח מקבל הודעת "לא מצאנו" + טיפים, **ללא חיוב**; האדמין מקבל התראה ✅
4. **נמצא + `admin_approval=true`** (ברירת המחדל): האדמין מקבל ב-WhatsApp את הדוח המלא + קישור אישור.
   - הקישור משתמש ב-**8 תווים ראשונים** של ה-UUID (בלי מקפים — WhatsApp שובר קישורים במקף בטקסט RTL) ✅
   - **אישור דו-שלבי**: GET ראשון מציג דף אישור (כדי ש-link-preview של WhatsApp לא יאשר לבד); רק `confirm=yes` מבצע ✅
   - idempotent: בקשה שכבר טופלה מציגה "הבקשה כבר טופלה" ✅
5. **אחרי אישור** — `sendTeaserWithPayment`:
   - **מצב פרודקשן** (`test_mode=false`): נוצר קישור SUMIT (תוקף 48ש'), נשלח ללקוח טיזר + disclaimers + קישור; `status='awaiting_payment'` ✅
   - **מצב טסט** (`test_mode=true`): טיזר נשלח, "תשלום" אוטומטי, מיד עוברים ל-handle-payment ✅
6. **handle-payment** (SUMIT redirect GET או webhook POST):
   - idempotent — שורה שכבר `sent` לא תשלח שוב ✅
   - `status='paid'` → שולח ללקוח את `customer_full` (הפרטים המלאים) → `status='sent'` → התראת "💳 תשלום התקבל" לאדמין → redirect לדף `?page=payment-success` ✅

### מכונת מצבים

```
pending → searching → found ──(אישור אדמין)──→ awaiting_payment ──(תשלום)──→ paid → sent
                    ↘ not_found (חינם, סופי)
                    ↘ failed (ולידציה/שגיאה, סיבה ב-admin_notes)
```
- ✅ שורות שנתקעות ב-`searching` (קריסה) מסומנות `failed` — try/catch פנימי + מיגרציית recovery.
- `sent_price` הוא סטטוס legacy שהומר ל-`awaiting_payment` (מיגרציה 2026-04-28).

---

## 4. מסע לקוח — VIP

1. טופס טקסט חופשי (שם, טלפון, אימייל, תיאור הבקשה) → insert עם `from_iata='VIP'`, `depart_date=today` (ולידציית מסלול מדולגת ל-VIP) ✅
2. **ניתוח AI** — שרשרת fallback:
   - **Anthropic Managed Agents** (`flight-vip-analyzer`, סוכן מנוהל, beta `managed-agents-2026-04-01`): session → user.message → polling עד idle (דדליין 22s) ✅
   - נפילה → **Messages API** (`claude-sonnet-4-6`) עם אותו פורמט ✅
   - שתיהן נכשלו → טקסט fallback; **השגיאה מוצפת** ל-`admin_notes`, ל-`ai_response.ai_error`, ולהודעת האדמין ("נדרש טיפול ידני — בדוק קרדיט/מפתח") ✅
   - פורמט הפלט (מוגדר ב-system prompt): סיכום / פרטים שזוהו / משימות לסוכן / מידע חסר — עברית בלבד, טיסות בלבד ✅
3. הלקוח מקבל אישור קבלה מיידי; האדמין מקבל את הבקשה + ניתוח ה-AI + קישור אישור ✅
4. אישור → טיזר + קישור SUMIT במחיר `vip_price` ✅
5. תשלום → הודעת VIP ייעודית ("👑 שירות VIP… סוכן אישי ייצור קשר") + הניתוח המלא ✅

---

## 5. מנוע החיפוש

שלושת המנועים רצים **במקביל** עם timeout 15s לכל אחד; מנוע שנופל לא מפיל את החיפוש ✅

| מנוע | API | הערות מימוש |
|---|---|---|
| Google Flights | SerpApi `google_flights`, `type=2` (one-way) | ✅ מסונן Business/First/Premium (גוגל מחזיר Business כשאין Economy); מסונן airline=Unknown |
| Skyscanner | RapidAPI `flights-sky` search-one-way | ✅ עד 6 תוצאות, פירוט segments |
| Kiwi.com | RapidAPI `kiwi-com-cheap-flights` one-way | ✅ פרמטרי תאריך: `outboundDepartureDateStart/End` (לא `departureDate`!); שדה `sector` (לא `outbound`); **virtual interlining** מופעל (`enableSelfTransfer` ועוד); adults/children אמיתיים; מחיר per-pax מוכפל (היוריסטיקה <$5k) |

**דדופ ומיון** (לכל כיוון):
- מפתח דדופ: `airline|stops|duration±15min` — הזול נשאר ✅
- מיון: ישירות קודם, בתוכן לפי מחיר ✅
- קונקשן נשמר רק אם זול מהישירה הזולה — **חוץ מ-virtual interlines של Kiwi שנשמרים תמיד** (זה היתרון הייחודי שלהם) ומסומנים `🔀 (חיבור עצמאי)` ✅

**סטטיסטיקות לאדמין**: כמה תוצאות מכל מנוע, כמה VI, סה"כ ייחודיות ✅

---

## 6. הודעות WhatsApp (Green API)

- Instance: `7103871299` (מספר עסקי `0524881496`), token ב-settings ✅
- כל שליחה דרך `sendWhatsApp()` — timeout 8s, מחזיר `{ok,error}`, כשל נרשם ולא מפיל flow ✅
- נירמול טלפון: `normalizeIsraeliPhone` מקבל כל פורמט → `05…` → chatId `972…@c.us` ✅

### הודעות יוצאות (לפי סדר ה-flow)
1. אישור קבלה (מיידי, אחרי insert) ✅
2. טיזר + קישור תשלום (אחרי אישור אדמין) — עם disclaimers קבועים ✅
3. פרטים מלאים (אחרי תשלום) ✅
4. לאדמין: בקשה חדשה+דוח+קישור אישור · תשלום התקבל · חיפוש ללא תוצאות · הודעת לקוח נכנסת ✅

### הודעות נכנסות — handle-reply (webhook)
סינון לפי סדר:
1. סוגי webhook יוצאים (`outgoing*`) → התעלמות ✅
2. **הודעות קבוצה** (`chatId` מסתיים `@g.us`) → התעלמות ✅
3. שולח שאינו ב-`requests` (בכל וריאנט פורמט טלפון) → התעלמות שקטה (ספאם/אנשי קשר) ✅
4. לקוח עם בקשה **פעילה** (`pending/searching/found/awaiting_payment`) בלבד:
   - "כן"/"yes"/"1"/"👍" בזמן `awaiting_payment` → הודעת הרגעה ללקוח + התראת אדמין ✅
   - כל הודעה אחרת → הועברת לאדמין עם הקשר הבקשה ✅
5. לקוח שכבר `paid/sent/not_found/failed` → אין התראה (הכדור אצלו) ✅

---

## 7. תשלומים (SUMIT)

- `beginredirect` עם `ExternalIdentifier=request.id`, `RedirectURL` → handle-payment, תוקף 48 שעות, תשלום אחד ✅
- מחיר: `service_price` רגיל, `vip_price` ל-VIP ✅
- ⚠️ **אין אימות חתימה/סכום מול SUMIT** — handle-payment סומך על ה-redirect. מי שמנחש request_id של בקשה ב-awaiting_payment יכול "לשחרר" תוצאות בלי לשלם. סיכון נמוך (UUID לא ניתן לניחוש) אבל לא אפס: קישור עם ה-id נמצא בהודעות. → פער פתוח: לאמת מול SUMIT API לפני שליחת פרטים.
- `test_mode=true` עוקף SUMIT לגמרי (לבדיקות) ✅

---

## 8. הגדרות (טבלת settings)

| קבוצה | מפתחות |
|---|---|
| מנועים | `serpapi_key`, `skyfare_key` (RapidAPI) |
| AI | `claude_key`, `managed_agent_id`, `managed_env_id` |
| WhatsApp | `green_instance`, `green_token`, `admin_whatsapp` |
| סליקה | `sumit_company_id`, `sumit_api_key` |
| תמחור | `service_price`, `vip_price` |
| התנהגות | `test_mode`, `admin_approval` |
| אחר | `admin_password`, `site_url`, `webhook_*` |

- ✅ `get_public_settings()` — חושף לציבור רק תמחור/webhooks/test_mode/site_url
- ✅ `get_admin_settings(pw)` / `set_admin_setting(pw,k,v)` — מוגני סיסמה, בשימוש הדשבורד
- ✅ אישור קבלה, מפתחות וטוקנים — צד שרת בלבד

---

## 9. אבטחה 🔒

| פריט | מצב |
|---|---|
| SPA לא מקבל טוקנים | ✅ מאז `f19595e` |
| RPCs מוגני סיסמה לאדמין | ✅ |
| אישור אדמין דו-שלבי + prefix | ✅ |
| idempotency בתשלום | ✅ |
| **RLS על settings עדיין פתוח** (`select using(true)`) | ⚠️ ה-SPA כבר לא צריך את זה — נותר להריץ את שלוש שורות ה-`drop policy` שבמיגרציה. **חסם: לרוטט קודם את כל המפתחות שדלפו** (admin_password=`hunter2025`, Anthropic, SerpApi, RapidAPI, SUMIT) |
| RLS על requests פתוח לקריאה/עדכון | ⚠️ הדשבורד קורא ישירות; לקוח טכני יכול לקרוא בקשות של אחרים. לתקן יחד עם נעילת settings |
| אימות תשלום מול SUMIT | ⚠️ ראה §7 |

---

## 10. תפעול

- **לוגים**: JSON מובנה (`logInfo`/`logError` עם stage) בכל הפונקציות ✅
- **Recovery**: בקשות שנתקעו ב-`searching` מעל 5 דק' → `failed` (מיגרציה; ⚠️ חד-פעמי — אין cron קבוע)
- **דשבורד אדמין** (`?page=admin`): רשימת בקשות + פילטרים, סטטיסטיקות הכנסה, עריכת הגדרות, עדכון סטטוס ידני, רענון כל 30ש' ✅
- ⚠️ **אין תזכורת על בקשות שממתינות לאישור אדמין** — בקשה שהאדמין פספס תישאר `found` לנצח (קרה בפועל: בקשת 18/6)
- ⚠️ חוב פתוח ב-Green API (באנר "תשלום נדרש", instance ישן `7103274027` באיחור)

---

## 11. פערים פתוחים — סיכום לפי עדיפות

1. **רוטציית מפתחות + נעילת RLS** (settings + requests) — הדליפה ההיסטורית עדיין רלוונטית כל עוד המפתחות הישנים בתוקף
2. **אימות תשלום מול SUMIT** לפני שליחת פרטים מלאים
3. **תזכורת אוטומטית לאדמין** על בקשות `found` שלא טופלו (cron / התראה חוזרת אחרי שעה)
4. **cron קבוע ל-recovery** של בקשות תקועות
5. חוב Green API
