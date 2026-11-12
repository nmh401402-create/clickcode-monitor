// Minimal Supabase REST client (read, plus the monitor's own state table). No dependencies.
export function createDb(url, serviceKey, fetchImpl = fetch) {
    const base = String(url || '').replace(/\/+$/, '');
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

    async function select(table, query, { max = 20000 } = {}) {
        const out = [];
        for (let from = 0; from < max; from += 1000) {
            const res = await fetchImpl(`${base}/rest/v1/${table}?${query}`, {
                headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
            const rows = await res.json();
            out.push(...rows);
            if (rows.length < 1000) break;
        }
        return out;
    }

    async function getState(key) {
        try {
            const rows = await select('monitor_state', `key=eq.${encodeURIComponent(key)}&select=value`, { max: 1 });
            return rows[0]?.value ?? {};
        } catch {
            return {};
        }
    }

    async function setState(key, value) {
        const res = await fetchImpl(`${base}/rest/v1/monitor_state`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`monitor_state write: HTTP ${res.status}`);
    }

    return { select, getState, setState };
}
