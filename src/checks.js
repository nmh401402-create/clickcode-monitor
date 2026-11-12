import { classifyClick, groupClicks, providerSuspicion, silentClients, israelParts, LATE_MS } from './analysis.js';

async function timed(url, timeoutMs, fetchImpl) {
    const t0 = Date.now();
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'monitor' } });
    return { res, ms: Date.now() - t0 };
}

const mask = (email) => String(email).replace(/^(.).*(@.*)$/, '$1***$2');

/**
 * Each check -> { key, name, ok, detail, critical }.  critical = immediate alert (Telegram + email).
 * Nothing here ever prints a code, a password or a key.
 */
export async function runChecks({ env, db, now = new Date(), fetchImpl = fetch }) {
    const results = [];
    const add = (key, name, ok, detail, critical = false) => results.push({ key, name, ok, detail, critical });
    const siteUrl = env.SITE_URL || 'https://clickcode.co.il';
    const apiUrl = (env.API_URL || 'https://clickcode.onrender.com').replace(/\/+$/, '');

    // 1. Portal (Vercel)
    try {
        const { res, ms } = await timed(siteUrl, 15_000, fetchImpl);
        add('site', 'האתר (Vercel)', res.ok, res.ok ? `תקין, ${ms}ms` : `סטטוס ${res.status}`, true);
    } catch (e) {
        add('site', 'האתר (Vercel)', false, `לא נגיש (${e.name})`, true);
    }

    // 2. API on Render (+ cold start / slowness), one retry before calling it down
    let api = null;
    for (let attempt = 0; attempt < 2 && !api?.ok; attempt++) {
        try {
            const { res, ms } = await timed(`${apiUrl}/health`, 45_000, fetchImpl);
            const body = await res.json().catch(() => ({}));
            api = { ok: res.ok && body.status === 'ok', ms, body, status: res.status };
        } catch (e) {
            api = { ok: false, ms: null, err: e.name };
        }
        if (!api.ok && attempt === 0) await new Promise((r) => setTimeout(r, 8000));
    }
    if (!api.ok) {
        add('api', 'השרת (Render)', false, api.err ? `לא ענה (${api.err})` : `סטטוס ${api.status}, בסיס נתונים: ${api.body?.checks?.database}`, true);
    } else {
        const woke = api.body.uptime_seconds != null && api.body.uptime_seconds < 600;
        const slow = api.ms > 8000;
        add('api', 'השרת (Render)', true, `תקין, ${api.ms}ms${woke ? ', הופעל מחדש/התעורר לאחרונה' : ''}${slow ? ', איטי' : ''}`);
        add('api_slow', 'מהירות השרת', !slow, slow ? `תגובה איטית: ${api.ms}ms (ייתכן התעוררות משינה)` : 'תקינה');
    }

    // 3. Supabase
    try {
        await db.select('clients', 'select=id&limit=1', { max: 1 });
        add('supabase', 'בסיס הנתונים (Supabase)', true, 'תקין', true);
    } catch (e) {
        add('supabase', 'בסיס הנתונים (Supabase)', false, `שגיאה: ${e.message}`, true);
    }

    // 4. IMAP mailboxes: the server writes an open alert when a mailbox fails
    try {
        const rows = await db.select('system_alerts', `select=error_title,created_at&status=neq.${encodeURIComponent('נפתר')}&error_title=ilike.*IMAP*`, { max: 200 });
        const boxes = [...new Set(rows.map((r) => (String(r.error_title).split(': ')[1] || '').trim()).filter(Boolean))];
        add('imap', 'תיבות מייל (IMAP)', rows.length === 0, rows.length ? `${rows.length} התראות פתוחות: ${boxes.slice(0, 6).map(mask).join(', ')}` : 'אין תיבות תקועות');
    } catch (e) {
        add('imap', 'תיבות מייל (IMAP)', true, `לא נבדק (${e.message})`);
    }

    // 5. Webhook freshness (only on working hours, Sun-Thu)
    try {
        const p = israelParts(now);
        const working = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday) && p.hour >= 9 && p.hour < 19;
        const last = await db.select('sms_logs', 'select=created_at&order=created_at.desc&limit=1', { max: 1 });
        const ageH = last[0] ? (now.getTime() - Date.parse(last[0].created_at)) / 3600_000 : null;
        const quiet = working && ageH != null && ageH > 4;
        add('webhook', 'הודעות נכנסות (וובהוק/מייל)', !quiet, quiet ? `לא הגיעה אף הודעה כבר ${ageH.toFixed(1)} שעות בשעות עבודה` : ageH == null ? 'אין הודעות עדיין' : `הודעה אחרונה לפני ${ageH.toFixed(1)} שעות`);
    } catch (e) {
        add('webhook', 'הודעות נכנסות (וובהוק/מייל)', true, `לא נבדק (${e.message})`);
    }

    // 6. Code timing from otp_events (needs migration 26 + new server)
    try {
        const since = new Date(now.getTime() - 30 * 60_000).toISOString();
        const events = await db.select('otp_events', `select=*&created_at=gte.${since}`);
        const sms = await db.select('sms_logs', `select=user_id,created_at&created_at=gte.${since}`);
        const clicks = groupClicks(events);
        const kinds = clicks.map((c) => ({ ...c, kind: classifyClick(c, sms, now.getTime()) }));
        const late = kinds.filter((k) => k.kind === 'late').length;
        add('late_codes', 'איחורי קודים (30 דק׳ אחרונות)', late < 3, late ? `${late} קודים באיחור של מעל ${LATE_MS / 1000} שניות` : 'אין איחורים');
        const notArrived = kinds.filter((k) => k.kind === 'not_arrived');
        const andn = kinds.filter((k) => k.kind === 'arrived_not_delivered').length;
        add('provider', 'הודעות שלא הגיעו (חשד לספק)', !providerSuspicion(notArrived), providerSuspicion(notArrived) ? `${notArrived.length} לחיצות בלי הודעה, מכמה לקוחות יחד — חשד לתקלה אצל ספק/חברת תקשורת` : `${notArrived.length} לחיצות בלי הודעה ב-30 דקות (לא חריג)`);
        add('not_delivered', 'הגיעו ולא נמסרו', andn < 2, andn ? `${andn} הודעות הגיעו אבל לא נמסרו ללקוח (תקלה אצלנו)` : 'אין');
    } catch {
        /* table not created yet: skip silently */
    }

    // 7. Customer that suddenly stopped receiving codes
    try {
        const since = new Date(now.getTime() - 14 * 24 * 3600_000).toISOString();
        const clients = await db.select('clients', 'select=id,name,user_id,status');
        const sms = await db.select('sms_logs', `select=user_id,created_at&created_at=gte.${since}`, { max: 60000 });
        const silent = silentClients(clients, sms, now);
        for (const c of clients.filter((x) => x.user_id)) {
            const hit = silent.find((s) => s.id === c.id);
            add(`silent:${c.id}`, `לקוח שקט: ${c.name}`, !hit, hit ? `לא קיבל אף הודעה ב-24 שעות (קיבל ${hit.previous} ב-13 הימים שלפני)` : 'פעיל');
        }
    } catch (e) {
        add('silent', 'לקוחות שקטים', true, `לא נבדק (${e.message})`);
    }

    // 8. Third-party status pages (best effort: a failed lookup is ignored)
    const pages = [
        ['vercel_status', 'Vercel (סטטוס רשמי)', 'https://www.vercel-status.com/api/v2/status.json'],
        ['supabase_status', 'Supabase (סטטוס רשמי)', 'https://status.supabase.com/api/v2/status.json'],
        ['resend_status', 'Resend (סטטוס רשמי)', 'https://resend-status.com/api/v2/status.json'],
    ];
    for (const [key, name, url] of pages) {
        try {
            const { res } = await timed(url, 10_000, fetchImpl);
            const body = await res.json();
            const ind = body?.status?.indicator;
            add(key, name, !ind || ind === 'none', ind && ind !== 'none' ? `${body.status.description}` : 'תקין');
        } catch {
            /* unknown -> not reported as a failure */
        }
    }
    return results;
}
