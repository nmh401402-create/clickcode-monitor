import { createDb } from './db.js';
import { runChecks } from './checks.js';
import { createNotifier } from './notify.js';
import { buildReport } from './report.js';
import { israelParts } from './analysis.js';

const env = process.env;
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const LISTEN_SECONDS = Number(env.LISTEN_SECONDS || 0);
const REMIND_MS = 3 * 3600_000;

const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((k) => !env[k]);
if (missing.length) {
    // Not set up yet: skip quietly (exit 0) so GitHub does not email a failure every 5 minutes.
    console.log(`::warning::Monitor not configured yet, missing secrets: ${missing.join(', ')}`);
    process.exit(0);
}

const db = createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const real = createNotifier(env);
const notifier = DRY
    ? { ...real, telegram: async (t) => (console.log('[telegram]\n' + t), true), email: async (s, t) => (console.log('[email]', s, '\n' + t), true) }
    : real;

const ICON = { ok: '✅', warn: '⚠️', bad: '🔴' };

async function loadData(hours, now) {
    const since = new Date(now - hours * 3600_000).toISOString();
    const [events, smsLogs, clients, devices] = await Promise.all([
        db.select('otp_events', `select=*&created_at=gte.${since}`).catch(() => []),
        db.select('sms_logs', `select=user_id,created_at&created_at=gte.${since}`, { max: 60000 }),
        db.select('clients', 'select=id,name,user_id,status'),
        db.select('device_tokens', 'select=id,device_name'),
    ]);
    return { events, smsLogs, clients, devices };
}

async function report(title, hours, checks) {
    const now = Date.now();
    return buildReport({ title, checks, now, ...(await loadData(hours, now)) });
}

function statusLines(checks) {
    return checks
        .filter((c) => !c.key.startsWith('silent:') || !c.ok)
        .map((c) => `${c.ok ? ICON.ok : c.critical ? ICON.bad : ICON.warn} ${c.name}: ${c.detail}`)
        .join('\n');
}

async function handleAlerts(checks, state, nowMs) {
    state.checks ||= {};
    for (const c of checks) {
        const prev = (state.checks[c.key] ||= { fails: 0, alerted: false, lastAlertAt: 0 });
        if (!c.ok) {
            prev.fails++;
            const need = c.critical ? 1 : 2;
            const due = !prev.alerted ? prev.fails >= need : c.critical && nowMs - prev.lastAlertAt > REMIND_MS;
            if (due) {
                const text = `${c.critical ? ICON.bad + ' תקלה חמורה' : ICON.warn + ' התראה'}\n${c.name}: ${c.detail}`;
                await notifier.telegram(text);
                if (c.critical) await notifier.email(`ClickCode: תקלה — ${c.name}`, text);
                prev.alerted = true;
                prev.lastAlertAt = nowMs;
            }
        } else {
            if (prev.alerted) {
                const text = `✅ חזר לתקין\n${c.name}: ${c.detail}`;
                await notifier.telegram(text);
                if (c.critical) await notifier.email(`ClickCode: חזר לתקין — ${c.name}`, text);
            }
            prev.fails = 0;
            prev.alerted = false;
        }
    }
}

async function maybeReports(checks, state, now) {
    const p = israelParts(now);
    if (p.hour >= 19 && state.lastDaily !== p.dateKey) {
        const text = await report('דוח יומי — 24 שעות אחרונות', 24, checks);
        await notifier.telegram(text);
        await notifier.email(`ClickCode: דוח יומי ${p.dateKey}`, text);
        state.lastDaily = p.dateKey;
    }
    if (p.weekday === 'Thu' && p.hour >= 22 && state.lastWeekly !== p.dateKey) {
        const text = await report('דוח שבועי — 7 ימים אחרונים', 24 * 7, checks);
        await notifier.telegram(text);
        await notifier.email(`ClickCode: דוח שבועי ${p.dateKey}`, text);
        state.lastWeekly = p.dateKey;
    }
}

const HELP = 'אפשר לשלוח:\nמצב — תמונת מצב עכשיו\nהיום — סיכום 24 שעות\nשבוע — סיכום 7 ימים\n(תשובה תוך כדקה-שתיים, לפעמים עד 5 דקות)';

async function answer(text) {
    const t = text.toLowerCase().replace(/^\//, '');
    if (/^(status|מצב|סטטוס|תמונת מצב)/.test(t)) {
        const checks = await runChecks({ env, db });
        return `📸 תמונת מצב\n${statusLines(checks)}\n\n${await report('שעתיים אחרונות', 2, null)}`;
    }
    if (/^(today|היום|יומי)/.test(t)) return report('סיכום 24 שעות', 24, await runChecks({ env, db }));
    if (/^(week|שבוע|שבועי)/.test(t)) return report('סיכום 7 ימים', 24 * 7, await runChecks({ env, db }));
    return HELP;
}

async function listen(state) {
    const deadline = Date.now() + LISTEN_SECONDS * 1000;
    do {
        const wait = LISTEN_SECONDS > 0 ? Math.min(20, Math.max(1, Math.floor((deadline - Date.now()) / 1000))) : 0;
        const updates = await real.getCommands(state.tgOffset || 0, wait);
        for (const u of updates) {
            state.tgOffset = u.updateId + 1;
            if (!u.fromOwner || !u.text) continue; // anyone else is ignored
            try {
                await notifier.telegram(await answer(u.text));
            } catch (e) {
                await notifier.telegram(`לא הצלחתי לבדוק עכשיו: ${e.message}`);
            }
        }
        if (updates.length) await db.setState('monitor', state);
    } while (Date.now() < deadline - 1000);
}

const now = new Date();
const state = await db.getState('monitor');
const checks = await runChecks({ env, db, now });
await handleAlerts(checks, state, now.getTime());
if (args.has('--force-daily')) state.lastDaily = null;
await maybeReports(checks, state, now);
if (DRY) console.log('\n--- checks ---\n' + statusLines(checks));
if (!DRY) await db.setState('monitor', state);
if (real.hasTelegram && !DRY) await listen(state);
if (!DRY) await db.setState('monitor', state);
console.log(`done: ${checks.filter((c) => !c.ok).length} failing of ${checks.length}`);
