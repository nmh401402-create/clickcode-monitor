// Pure functions: no network, no secrets. Everything here is unit-tested.
export const LATE_MS = 20_000;
const PENDING_MS = 3 * 60_000; // a click this recent may still get its code

export function israelParts(date = new Date()) {
    const f = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    return {
        dateKey: `${p.year}-${p.month}-${p.day}`,
        hour: Number(p.hour),
        minute: Number(p.minute),
        weekday: p.weekday, // Sun Mon Tue Wed Thu Fri Sat
    };
}

/** One row per real click (device + click time). A click is delivered if any request got a code. */
export function groupClicks(events) {
    const map = new Map();
    for (const e of events) {
        if (!e.click_at) continue; // no click -> not a real code request
        const key = `${e.device_id || e.user_id || '-'}|${e.click_at}`;
        let c = map.get(key);
        if (!c) {
            c = { key, clientId: e.client_id, userId: e.user_id, deviceId: e.device_id, clickAt: e.click_at, delivered: false, latencyMs: null };
            map.set(key, c);
        }
        if (e.outcome === 'delivered' || e.outcome === 'redelivered') c.delivered = true;
        if (e.outcome === 'delivered' && e.latency_ms != null) {
            c.latencyMs = c.latencyMs == null ? e.latency_ms : Math.min(c.latencyMs, e.latency_ms);
        }
    }
    return [...map.values()];
}

/**
 * Why did a click end with no code?
 *  arrived_not_delivered = a message for this owner arrived around the click but was not handed out (our side)
 *  not_arrived           = nothing arrived (telecom / Ministry / number forwarding)
 *  pending               = too recent to judge
 */
export function classifyClick(click, smsLogs, now = Date.now()) {
    if (click.delivered) return click.latencyMs != null && click.latencyMs > LATE_MS ? 'late' : 'ok';
    const t = Date.parse(click.clickAt);
    if (now - t < PENDING_MS) return 'pending';
    const arrived = smsLogs.some(
        (s) => s.user_id === click.userId && Date.parse(s.created_at) >= t - 60_000 && Date.parse(s.created_at) <= t + 5 * 60_000,
    );
    return arrived ? 'arrived_not_delivered' : 'not_arrived';
}

export function percentile(values, p) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/** Several different customers with no message within 15 minutes = likely a provider-wide problem. */
export function providerSuspicion(notArrivedClicks, windowMs = 15 * 60_000, minClients = 3) {
    const list = notArrivedClicks.map((c) => ({ t: Date.parse(c.clickAt), client: c.clientId || c.userId })).sort((a, b) => a.t - b.t);
    for (let i = 0; i < list.length; i++) {
        const set = new Set();
        for (let j = i; j < list.length && list[j].t - list[i].t <= windowMs; j++) set.add(list[j].client);
        if (set.size >= minClients) return true;
    }
    return false;
}

/** Customers that normally get codes but got none in the last 24 hours (evaluated Mon-Thu only). */
export function silentClients(clients, smsLogs, now = new Date()) {
    if (!['Mon', 'Tue', 'Wed', 'Thu'].includes(israelParts(now).weekday)) return [];
    const nowMs = now.getTime();
    const out = [];
    for (const c of clients) {
        if (!c.user_id || (c.status && c.status !== 'active')) continue;
        let before = 0;
        let last24 = 0;
        for (const s of smsLogs) {
            if (s.user_id !== c.user_id) continue;
            const age = nowMs - Date.parse(s.created_at);
            if (age <= 24 * 3600_000) last24++;
            else if (age <= 14 * 24 * 3600_000) before++;
        }
        if (before >= 10 && last24 === 0) out.push({ id: c.id, name: c.name, previous: before });
    }
    return out;
}

export function summarize({ events, smsLogs, now = Date.now() }) {
    const clicks = groupClicks(events);
    const tally = { ok: 0, late: 0, arrived_not_delivered: 0, not_arrived: 0, pending: 0, repeat: 0 };
    const REPEAT_MS = 3 * 60_000;
    const deliveredByWho = clicks.filter((c) => c.delivered).map((c) => ({ who: c.deviceId || c.userId, t: Date.parse(c.clickAt) }));
    const rows = clicks.map((c) => {
        let kind = classifyClick(c, smsLogs, now);
        // A failed click right next to a successful click of the same person is a re-click, not a real failure.
        if ((kind === 'not_arrived' || kind === 'arrived_not_delivered') && deliveredByWho.some((d) => d.who === (c.deviceId || c.userId) && Math.abs(d.t - Date.parse(c.clickAt)) <= REPEAT_MS)) {
            kind = 'repeat';
        }
        tally[kind]++;
        return { ...c, kind };
    });
    const latencies = rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);
    return {
        clicks: rows,
        tally,
        total: rows.length,
        delivered: tally.ok + tally.late,
        medianMs: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
    };
}
