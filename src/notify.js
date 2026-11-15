import { splitMessage } from './report.js';

// Permanent buttons under the chat input (Telegram "reply keyboard").
export const KEYBOARD = {
    keyboard: [[{ text: 'מצב עכשיו' }], [{ text: 'דוח יומי' }, { text: 'דוח שבועי' }]],
    resize_keyboard: true,
    is_persistent: true,
};

export function createNotifier(env, fetchImpl = fetch) {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    async function telegram(text) {
        if (!token || !chatId) return false;
        let ok = true;
        for (const part of splitMessage(text)) {
            const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true, reply_markup: KEYBOARD }),
                signal: AbortSignal.timeout(15_000),
            }).catch(() => null);
            if (!res || !res.ok) ok = false;
        }
        return ok;
    }

    async function email(subject, text) {
        if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) return false;
        const res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: env.ALERT_EMAIL_FROM || 'ClickCode Monitor <onboarding@resend.dev>',
                to: [env.ALERT_EMAIL_TO],
                subject,
                text,
            }),
            signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        return Boolean(res?.ok);
    }

    /** Telegram updates addressed to the owner only. Returns [{ updateId, text }]. */
    async function getCommands(offset, waitSeconds) {
        if (!token || !chatId) return [];
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${waitSeconds}`, {
            signal: AbortSignal.timeout((waitSeconds + 10) * 1000),
        }).catch(() => null);
        if (!res?.ok) return [];
        const body = await res.json().catch(() => ({}));
        return (body.result || []).map((u) => ({
            updateId: u.update_id,
            fromOwner: String(u.message?.chat?.id) === String(chatId),
            text: String(u.message?.text || '').trim(),
        }));
    }

    return { telegram, email, getCommands, hasTelegram: Boolean(token && chatId) };
}
