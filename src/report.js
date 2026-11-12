import { israelParts, summarize } from './analysis.js';

const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}ש׳`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function hourOf(iso) {
    return israelParts(new Date(iso)).hour;
}

/**
 * Plain-text Hebrew report. Never contains codes, phone numbers or message text.
 * Devices are shown only by the name stored in device_tokens.device_name.
 */
export function buildReport({ title, events, smsLogs, clients, devices, checks, now = Date.now() }) {
    const s = summarize({ events, smsLogs, now });
    const lines = [`📊 ${title}`, ''];

    if (checks?.length) {
        const bad = checks.filter((c) => !c.ok);
        lines.push(bad.length ? `מערכות: ⚠️ ${bad.length} בעיות` : 'מערכות: ✅ הכל תקין');
        for (const c of bad) lines.push(` • ${c.name}: ${c.detail}`);
        lines.push('');
    }

    lines.push(`הודעות שהגיעו למערכת: ${smsLogs.length}`);
    if (!events.length) {
        lines.push('לחיצות על "שלחו לי קוד": אין עדיין נתונים (המיגרציה/השרת החדש עוד לא פעילים).');
    } else {
        lines.push(`לחיצות על "שלחו לי קוד": ${s.total}`);
        lines.push(` ✅ הוזרם קוד בזמן: ${s.tally.ok} (${pct(s.tally.ok, s.total)})`);
        lines.push(` 🐢 איחור (מעל 20ש׳): ${s.tally.late}`);
        lines.push(` ❌ הגיע ולא נמסר (אצלנו): ${s.tally.arrived_not_delivered}`);
        lines.push(` ❌ לא הגיעה הודעה כלל: ${s.tally.not_arrived}`);
        if (s.tally.pending) lines.push(` ⏳ עדיין מחכים: ${s.tally.pending}`);
        lines.push(`זמן מלחיצה למסירה: חציוני ${sec(s.medianMs)}, 95% עד ${sec(s.p95Ms)}`);
        lines.push('(הצלחת ההזרקה בתוך האתר עצמו עדיין לא נמדדת — שלב 2 עם התוסף.)');
    }

    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    const byClient = new Map();
    for (const r of s.clicks) {
        const k = r.clientId || r.userId || '?';
        const t = byClient.get(k) || { ok: 0, late: 0, and: 0, na: 0, total: 0 };
        t.total++;
        if (r.kind === 'ok') t.ok++;
        else if (r.kind === 'late') t.late++;
        else if (r.kind === 'arrived_not_delivered') t.and++;
        else if (r.kind === 'not_arrived') t.na++;
        byClient.set(k, t);
    }
    if (byClient.size) {
        lines.push('', 'לפי לקוח (הבעייתיים קודם):');
        const sorted = [...byClient.entries()].sort((a, b) => (b[1].late + b[1].and + b[1].na) - (a[1].late + a[1].and + a[1].na));
        for (const [k, t] of sorted.slice(0, 20)) {
            lines.push(` • ${nameOf.get(k) || 'לא ידוע'}: ${t.total} לחיצות, ${t.ok} בזמן, ${t.late} באיחור, ${t.and} לא נמסרו, ${t.na} לא הגיעו`);
        }
        if (sorted.length > 20) lines.push(` …ועוד ${sorted.length - 20} לקוחות`);
    }

    const byHour = new Array(24).fill(0);
    const badHour = new Array(24).fill(0);
    for (const r of s.clicks) {
        const h = hourOf(r.clickAt);
        byHour[h]++;
        if (['late', 'arrived_not_delivered', 'not_arrived'].includes(r.kind)) badHour[h]++;
    }
    const hours = byHour.map((n, h) => ({ h, n, bad: badHour[h] })).filter((x) => x.bad > 0).sort((a, b) => b.bad - a.bad).slice(0, 3);
    if (hours.length) lines.push('', 'שעות עם הכי הרבה תקלות: ' + hours.map((x) => `${String(x.h).padStart(2, '0')}:00 (${x.bad} מתוך ${x.n})`).join(', '));

    const devName = new Map(devices.map((d) => [d.id, d.device_name]));
    const byDev = new Map();
    for (const r of s.clicks) {
        if (!r.deviceId) continue;
        const t = byDev.get(r.deviceId) || { total: 0, bad: 0 };
        t.total++;
        if (['late', 'arrived_not_delivered', 'not_arrived'].includes(r.kind)) t.bad++;
        byDev.set(r.deviceId, t);
    }
    const devBad = [...byDev.entries()].filter(([, t]) => t.bad).sort((a, b) => b[1].bad - a[1].bad).slice(0, 5);
    if (devBad.length) {
        lines.push('', 'מכשירים עם תקלות (לפי השם שנשמר):');
        for (const [id, t] of devBad) lines.push(` • ${devName.get(id) || 'מכשיר לא מזוהה'}: ${t.bad} מתוך ${t.total}`);
    }
    return lines.join('\n');
}

export function splitMessage(text, max = 3800) {
    if (text.length <= max) return [text];
    const parts = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if ((cur + '\n' + line).length > max) {
            parts.push(cur);
            cur = line;
        } else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) parts.push(cur);
    return parts;
}
