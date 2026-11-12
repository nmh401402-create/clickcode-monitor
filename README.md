# ClickCode Monitor — סוכן ניטור

רץ ב-GitHub Actions כל 5 דקות (גם כשהמחשב כבוי). לא מעיר את Render מעבר ל-`/health` אחד.

## מה הוא עושה
- בודק: האתר, Render (נפילה, האטה, התעוררות), Supabase, תיבות IMAP (לפי התראות פתוחות), הודעות נכנסות, דפי הסטטוס של Vercel/Supabase/Resend.
- קודים: איחור (מעל 20 שניות), "הגיע ולא נמסר" (אצלנו), "לא הגיעה הודעה" (חברת תקשורת/משרד החינוך), לקוח שפסק לקבל קודים.
- התראה מיידית בנפילה חמורה (טלגרם + מייל), הודעת "חזר לתקין", דוח יומי 19:00, דוח שבועי חמישי 22:00.
- בטלגרם אפשר לשלוח: `מצב` / `היום` / `שבוע`.
- לא שומר ולא מדפיס קודים, מספרי טלפון או סיסמאות.

## מה לא נמדד עדיין
הצלחת ההזרקה בתוך אתר משרד החינוך (שלב 2, עם גרסת התוסף הבאה).

## התקנה (פעם אחת — מי שמבצע: בעל הפרויקט)
1. Supabase → SQL Editor: להריץ את `backend/26_otp_events.sql`.
2. לפרסם את השרת עם הקוד החדש (דחיפה ל-main).
3. טלגרם: לדבר עם `@BotFather`, `/newbot`, לשמור את ה-token. לשלוח לבוט הודעה כלשהי, ואז לפתוח בדפדפן
   `https://api.telegram.org/bot<TOKEN>/getUpdates` ולמצוא `"chat":{"id":...}` — זה ה-CHAT_ID.
4. ריפו חדש ב-GitHub (מומלץ ציבורי, כדי ש-Actions יהיה חינם), להעתיק אליו את תוכן התיקייה הזו.
5. Settings → Secrets and variables → Actions → להוסיף:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`.
6. Actions → clickcode-monitor → Run workflow, ולוודא שמגיעה הודעה.

בריפו פרטי: להחליף `LISTEN_SECONDS` ל-`'0'` ולשנות את ה-cron ל-`*/20` (בגלל מכסת הדקות החינמית). אז תשובות הבוט יתעכבו.

## בדיקה מקומית בלי לשלוח כלום
`SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node src/main.js --dry` (מדפיס למסך בלבד).
