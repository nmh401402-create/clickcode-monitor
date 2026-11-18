import { israelParts, summarize } from './analysis.js';

const sec = (ms) => (ms == null ? '—' : `${Math.round(ms / 1000)} שניות`);
const BAD = ['arrived_not_delivered', 'not_arrived']; // real failures: no code was handed over
const KIND_TEXT = {
    not_arrived: 'לא הגיעה הודעה כלל',
    arrived_not_delivered: 'ההודעה הגיעה ולא נמסרה',
    late: 'הקוד הגיע באיחור',
};
const hhmm = (iso) => {
    const p = israelParts(new Date(iso));
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

function hourOf(iso) {
    return israelParts(new Date(iso)).hour;
}

/**
 * Plain Hebrew report for a non-technical reader.
 * Never contains codes, phone numbers or message text.
 * Devices/people are shown only by the name stored in device_tokens.device_name.
 */
export function buildReport({ title, events, smsLogs, clients, devices, checks, now = Date.now() }) {
    const s = summarize({ events, smsLogs, now });
    const lines = [`📊 ${title}`, ''];

    const badChecks = (checks || []).filter((c) => !c.ok);
    if (checks?.length) {
        lines.push(badChecks.length ? `🔴 יש ${badChecks.length} בעיות במערכת:` : '🟢 המערכת תקינה, כל הבדיקות עברו');
        for (const c of badChecks) lines.push(`   • ${c.name}: ${c.detail}`);
        lines.push('');
    }

    if (!events.length) {
        lines.push(`הודעות שהגיעו למערכת: ${smsLogs.length}`);
        lines.push('אין עדיין נתוני לחיצות לתקופה הזאת.');
        return lines.join('\n');
    }

    const real = s.total - s.tally.repeat - s.tally.pending; // clicks that can be judged
    const good = s.tally.ok + s.tally.late; // the code arrived (even if slowly)
    const problems = s.tally.arrived_not_delivered + s.tally.not_arrived;
    const rate = real ? Math.round((good / real) * 100) : null;

    lines.push(
        rate == null ? 'אין עדיין לחיצות שאפשר לשפוט.' : `${rate >= 90 ? '🟢' : rate >= 75 ? '🟡' : '🔴'} ${good} מתוך ${real} בקשות קוד קיבלו קוד (${rate}%)`,
    );
    lines.push('');
    lines.push('מה קרה בכל בקשה:');
    lines.push(`✅ הקוד הגיע בזמן: ${s.tally.ok}`);
    if (s.tally.late) lines.push(`🐢 הקוד הגיע באיחור (מעל 20 שניות): ${s.tally.late}`);
    if (s.tally.not_arrived) lines.push(`📭 לא הגיעה הודעה כלל (חברת תקשורת / משרד החינוך): ${s.tally.not_arrived}`);
    if (s.tally.arrived_not_delivered) lines.push(`🔧 ההודעה הגיעה אבל לא נמסרה (תקלה אצלנו): ${s.tally.arrived_not_delivered}`);
    if (s.tally.repeat) lines.push(`🔁 לחיצות חוזרות אחרי הצלחה (לא נספרו ככישלון): ${s.tally.repeat}`);
    if (s.tally.pending) lines.push(`⏳ עדיין מחכים לקוד: ${s.tally.pending}`);
    lines.push('');
    lines.push(`⏱ מהירות: בדרך כלל ${sec(s.medianMs)}, ובמקרים האיטיים עד ${sec(s.p95Ms)}`);
    lines.push(`📩 הודעות שהגיעו למערכת בתקופה: ${smsLogs.length}`);

    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    const byClient = new Map();
    for (const r of s.clicks) {
        const k = r.clientId || r.userId || '?';
        const t = byClient.get(k) || { good: 0, bad: 0 };
        if (r.kind === 'ok' || r.kind === 'late') t.good++;
        else if (BAD.includes(r.kind)) t.bad++;
        byClient.set(k, t);
    }
    const clientsWithProblems = [...byClient.entries()].filter(([, t]) => t.bad).sort((a, b) => b[1].bad - a[1].bad).slice(0, 10);
    if (byClient.size && clientsWithProblems.length) {
        lines.push('', 'לקוחות עם בעיות (קוד שלא הגיע):');
        for (const [k, t] of clientsWithProblems) lines.push(`   • ${nameOf.get(k) || 'לא ידוע'}: ${t.bad} כשלונות מתוך ${t.good + t.bad}`);
    } else if (byClient.size) {
        lines.push('', 'לקוחות: אין לקוח עם בעיות 👍');
    }

    const byHour = new Array(24).fill(0);
    const badHour = new Array(24).fill(0);
    for (const r of s.clicks) {
        if (!['ok', 'late', ...BAD].includes(r.kind)) continue;
        const h = hourOf(r.clickAt);
        byHour[h]++;
        if (BAD.includes(r.kind)) badHour[h]++;
    }
    const hours = byHour.map((n, h) => ({ h, n, bad: badHour[h] })).filter((x) => x.bad >= 2).sort((a, b) => b.bad - a.bad).slice(0, 3);
    if (hours.length) {
        lines.push('', 'שעות עם הכי הרבה כישלונות:');
        for (const x of hours) lines.push(`   • ${String(x.h).padStart(2, '0')}:00 — ${x.bad} מתוך ${x.n}`);
    }

    const devName = new Map(devices.map((d) => [d.id, d.device_name]));
    const byDev = new Map();
    for (const r of s.clicks) {
        if (!r.deviceId || !['ok', 'late', ...BAD].includes(r.kind)) continue;
        const t = byDev.get(r.deviceId) || { total: 0, bad: 0 };
        t.total++;
        if (BAD.includes(r.kind)) t.bad++;
        byDev.set(r.deviceId, t);
    }
    const devBad = [...byDev.entries()].filter(([, t]) => t.bad >= 2).sort((a, b) => b[1].bad - a[1].bad).slice(0, 5);
    if (devBad.length) {
        lines.push('', 'מי נתקל בהכי הרבה כישלונות:');
        for (const [id, t] of devBad) lines.push(`   • ${devName.get(id) || 'מכשיר לא מזוהה'}: ${t.bad} מתוך ${t.total}`);
    }

    const detail = s.clicks.filter((r) => BAD.includes(r.kind) || r.kind === 'late').sort((a, b) => Date.parse(a.clickAt) - Date.parse(b.clickAt)).slice(0, 12);
    if (detail.length) {
        lines.push('', 'פירוט (כדי שתוכל לבדוק מול מה שזכור לך):');
        for (const r of detail) {
            lines.push(`   • ${hhmm(r.clickAt)} — ${devName.get(r.deviceId) || 'מכשיר לא מזוהה'} (${nameOf.get(r.clientId) || 'לא ידוע'}): ${KIND_TEXT[r.kind]}`);
        }
    }
    if (problems) lines.push('', 'ℹ️ "לא הגיעה הודעה" אומר שהמערכת לא קיבלה שום הודעה (לא בוובהוק ולא במייל) סביב הלחיצה.');
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
