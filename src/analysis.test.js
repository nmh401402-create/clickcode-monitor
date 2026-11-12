import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClick, groupClicks, providerSuspicion, silentClients, summarize } from './analysis.js';
import { buildReport, splitMessage } from './report.js';

const T0 = Date.parse('2026-11-12T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ev = (o) => ({ client_id: 'c1', user_id: 'u1', device_id: 'd1', click_at: iso(T0), outcome: 'delivered', latency_ms: 4000, ...o });

test('a click is delivered if any request got the code; latency is the fastest delivery', () => {
    const clicks = groupClicks([ev({ outcome: 'no_code', latency_ms: 25000 }), ev({ outcome: 'delivered', latency_ms: 31000 }), ev({ outcome: 'redelivered', latency_ms: 40000 })]);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].delivered, true);
    assert.equal(clicks[0].latencyMs, 31000);
});

test('events without a click are ignored', () => {
    assert.equal(groupClicks([ev({ click_at: null })]).length, 0);
});

test('late = delivered but over 20 seconds', () => {
    const [c] = groupClicks([ev({ latency_ms: 21000 })]);
    assert.equal(classifyClick(c, [], T0 + 60_000), 'late');
    const [d] = groupClicks([ev({ latency_ms: 19000 })]);
    assert.equal(classifyClick(d, [], T0 + 60_000), 'ok');
});

test('undelivered click: message arrived (our side) vs nothing arrived (telecom side) vs too recent', () => {
    const [c] = groupClicks([ev({ outcome: 'no_code', latency_ms: 25000 })]);
    assert.equal(classifyClick(c, [{ user_id: 'u1', created_at: iso(T0 + 10_000) }], T0 + 600_000), 'arrived_not_delivered');
    assert.equal(classifyClick(c, [{ user_id: 'u2', created_at: iso(T0 + 10_000) }], T0 + 600_000), 'not_arrived');
    assert.equal(classifyClick(c, [], T0 + 60_000), 'pending');
});

test('provider suspicion needs several different customers close in time', () => {
    const mk = (client, ms) => ({ clientId: client, clickAt: iso(T0 + ms) });
    assert.equal(providerSuspicion([mk('a', 0), mk('a', 1000), mk('a', 2000)]), false);
    assert.equal(providerSuspicion([mk('a', 0), mk('b', 60_000), mk('c', 120_000)]), true);
    assert.equal(providerSuspicion([mk('a', 0), mk('b', 3600_000), mk('c', 7200_000)]), false);
});

test('silent customer: used to get codes, none in 24h, only judged Mon-Thu', () => {
    const wed = new Date('2026-11-11T12:00:00Z'); // Wednesday
    const sat = new Date('2026-11-14T12:00:00Z'); // Saturday
    const old = Array.from({ length: 12 }, (_, i) => ({ user_id: 'u1', created_at: iso(wed.getTime() - (2 + i) * 24 * 3600_000 + 1000) }));
    const clients = [{ id: 'c1', name: 'A', user_id: 'u1', status: 'active' }];
    assert.equal(silentClients(clients, old, wed).length, 1);
    assert.equal(silentClients(clients, old, sat).length, 0);
    const recent = [...old, { user_id: 'u1', created_at: iso(wed.getTime() - 3600_000) }];
    assert.equal(silentClients(clients, recent, wed).length, 0);
});

test('report has counts, per-client lines, and never contains codes or phone numbers', () => {
    const events = [ev({ latency_ms: 3000 }), ev({ click_at: iso(T0 + 1000), outcome: 'no_code', latency_ms: 25000 })];
    const text = buildReport({ title: 'בדיקה', events, smsLogs: [], clients: [{ id: 'c1', name: 'צעדים' }], devices: [{ id: 'd1', device_name: 'Chrome A' }], checks: [], now: T0 + 3600_000 });
    assert.match(text, /צעדים/);
    assert.match(text, /לא הגיעה הודעה כלל: 1/);
    assert.match(text, /Chrome A/);
    assert.doesNotMatch(text, /\b\d{6}\b/);
    assert.equal(summarize({ events, smsLogs: [], now: T0 + 3600_000 }).total, 2);
});

test('long messages are split under the Telegram limit', () => {
    const parts = splitMessage(Array.from({ length: 600 }, (_, i) => `line ${i} xxxxxxxxxxxxxxxxxxxxxxxxxxx`).join('\n'));
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
});
