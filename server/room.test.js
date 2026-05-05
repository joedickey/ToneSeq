import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createClient } from 'redis';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Room } = require('./room.js');

const REDIS_URL = 'redis://localhost:6379';
const TEST_ROOM = 'ROOMTEST';

let redis;

beforeAll(async () => {
  redis = createClient({ url: REDIS_URL });
  await redis.connect();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

afterEach(async () => {
  const keys = await redis.keys(`{room:${TEST_ROOM}}:*`);
  if (keys.length) await redis.del(keys);
});

describe('Room class', () => {
  // ── Key format ──────────────────────────────────────────────

  it('uses hash-tagged keys for cluster safety', () => {
    const room = new Room(redis, TEST_ROOM);
    expect(room._tabSetKey()).toBe(`{room:${TEST_ROOM}}:tabs`);
    expect(room._tabDataKey('abc')).toBe(`{room:${TEST_ROOM}}:tab:abc`);
    expect(room._transportKey()).toBe(`{room:${TEST_ROOM}}:transport`);
  });

  // ── addTab / removeTab ──────────────────────────────────────

  it('addTab creates both set member and JSON data key atomically', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('t1', { tabId: 't1', name: 'Pinhead', color: '#FF6B6B', state: { bpm: 120 } });

    const members = await redis.sMembers(`{room:${TEST_ROOM}}:tabs`);
    expect(members).toContain('t1');

    const data = await redis.json.get(`{room:${TEST_ROOM}}:tab:t1`);
    expect(data.name).toBe('Pinhead');
    expect(data.state.bpm).toBe(120);
  });

  it('removeTab removes both set member and data key atomically', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('t2', { tabId: 't2', name: 'Chatterer', color: '#4ECDC4', state: {} });
    await room.removeTab('t2');

    const members = await redis.sMembers(`{room:${TEST_ROOM}}:tabs`);
    expect(members).not.toContain('t2');

    const data = await redis.json.get(`{room:${TEST_ROOM}}:tab:t2`).catch(() => null);
    expect(data).toBeNull();
  });

  // ── updateTabState ──────────────────────────────────────────

  it('updateTabState modifies only .state, preserves name/color', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('t3', { tabId: 't3', name: 'Spike', color: '#FFE66D', state: { bpm: 100 } });

    const result = await room.updateTabState('t3', { bpm: 140, grid: [[1, 0]] });
    expect(result).toBe(true);

    const data = await redis.json.get(`{room:${TEST_ROOM}}:tab:t3`);
    expect(data.name).toBe('Spike');
    expect(data.color).toBe('#FFE66D');
    expect(data.state.bpm).toBe(140);
    expect(data.state.grid).toEqual([[1, 0]]);
  });

  it('updateTabState returns false for non-existent tab', async () => {
    const room = new Room(redis, TEST_ROOM);
    const result = await room.updateTabState('nonexistent', { bpm: 120 });
    expect(result).toBe(false);
  });

  // ── updateTabLastEdit ───────────────────────────────────────

  it('updateTabLastEdit sets .lastEdit without touching other fields', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('t4', { tabId: 't4', name: 'Dreamer', color: '#A78BFA', state: { bpm: 120 } });

    const editMsg = { type: 'edit', source: 't4', target: 0, step: 3 };
    const result = await room.updateTabLastEdit('t4', editMsg);
    expect(result).toBe(true);

    const data = await redis.json.get(`{room:${TEST_ROOM}}:tab:t4`);
    expect(data.name).toBe('Dreamer');
    expect(data.state.bpm).toBe(120);
    expect(data.lastEdit.step).toBe(3);
  });

  // ── getTab / getAllTabs ─────────────────────────────────────

  it('getTab returns null for non-existent tab', async () => {
    const room = new Room(redis, TEST_ROOM);
    const data = await room.getTab('ghost');
    expect(data).toBeNull();
  });

  it('getAllTabs returns only existing tabs', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('a1', { tabId: 'a1', name: 'A', color: '#fff', state: {} });
    await room.addTab('a2', { tabId: 'a2', name: 'B', color: '#000', state: {} });

    // Remove a2's data key but leave it in the set (simulate partial failure)
    await redis.del(`{room:${TEST_ROOM}}:tab:a2`);

    const tabs = await room.getAllTabs();
    expect(Object.keys(tabs)).toEqual(['a1']);
    expect(tabs['a1'].name).toBe('A');
  });

  // ── Transport ───────────────────────────────────────────────

  it('setTransport / getTransport round-trips correctly', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.setTransport({ playing: true, bpm: 140, step: 7 });

    const t = await room.getTransport();
    expect(t.playing).toBe(true);
    expect(t.bpm).toBe(140);
    expect(t.step).toBe(7);
  });

  it('updateTransportStep modifies only .step field', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.setTransport({ playing: true, bpm: 120, step: 0 });
    await room.updateTransportStep(5);

    const t = await room.getTransport();
    expect(t.playing).toBe(true);
    expect(t.bpm).toBe(120);
    expect(t.step).toBe(5);
  });

  it('stores transport leader on play and preserves it across beat sync', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.updateTransportPlay('leader-1', 3);
    await room.updateTransportBeatSync({ step: 6, position: 7, arrayLength: 16 });

    const t = await room.getTransport();
    expect(t.playing).toBe(true);
    expect(t.leaderTabId).toBe('leader-1');
    expect(t.step).toBe(6);
    expect(t.position).toBe(7);
  });

  it('clears transport leader on stop', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.updateTransportPlay('leader-1', 3);
    await room.updateTransportStop();

    const t = await room.getTransport();
    expect(t.playing).toBe(false);
    expect(t.leaderTabId).toBeNull();
    expect(t.step).toBe(3);
  });

  it('stores play starting position without beat sync metadata', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.updateTransportPlay('leader-1', 3);

    const t = await room.getTransport();
    expect(t.playing).toBe(true);
    expect(t.leaderTabId).toBe('leader-1');
    expect(t.step).toBe(3);
    expect(t.position).toBe(3);
    expect(t.arrayLength).toBeUndefined();
  });

  it('updateTransportBeatSync stores position metadata without overwriting other fields', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.setTransport({ playing: true, bpm: 132, step: 0, leaderTabId: 'leader-2' });
    await room.updateTransportBeatSync({ step: 6, position: 7, arrayLength: 16 });

    const t = await room.getTransport();
    expect(t.playing).toBe(true);
    expect(t.bpm).toBe(132);
    expect(t.leaderTabId).toBe('leader-2');
    expect(t.step).toBe(6);
    expect(t.position).toBe(7);
    expect(t.arrayLength).toBe(16);
  });

  it('updateTransportStep is a no-op if transport key does not exist', async () => {
    const room = new Room(redis, TEST_ROOM);
    // Should not throw
    await room.updateTransportStep(3);
    const t = await room.getTransport();
    expect(t).toBeNull();
  });

  it('getTransport returns null when no transport exists', async () => {
    const room = new Room(redis, TEST_ROOM);
    const t = await room.getTransport();
    expect(t).toBeNull();
  });

  // ── TTL ─────────────────────────────────────────────────────

  it('sets TTL on all keys via addTab', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('ttl1', { tabId: 'ttl1', name: 'T', color: '#fff', state: {} });

    const tabSetTTL = await redis.ttl(`{room:${TEST_ROOM}}:tabs`);
    const tabDataTTL = await redis.ttl(`{room:${TEST_ROOM}}:tab:ttl1`);
    expect(tabSetTTL).toBeGreaterThan(86000);
    expect(tabDataTTL).toBeGreaterThan(86000);
  });

  it('sets TTL on transport key', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.setTransport({ playing: false, bpm: 120, step: 0 });

    const ttl = await redis.ttl(`{room:${TEST_ROOM}}:transport`);
    expect(ttl).toBeGreaterThan(86000);
  });

  it('refreshes TTL on updateTabState', async () => {
    const room = new Room(redis, TEST_ROOM);
    await room.addTab('ttl2', { tabId: 'ttl2', name: 'T', color: '#fff', state: {} });

    // Manually set a short TTL
    await redis.expire(`{room:${TEST_ROOM}}:tab:ttl2`, 10);
    const ttlBefore = await redis.ttl(`{room:${TEST_ROOM}}:tab:ttl2`);
    expect(ttlBefore).toBeLessThanOrEqual(10);

    await room.updateTabState('ttl2', { bpm: 200 });
    const ttlAfter = await redis.ttl(`{room:${TEST_ROOM}}:tab:ttl2`);
    expect(ttlAfter).toBeGreaterThan(86000);
  });
});
