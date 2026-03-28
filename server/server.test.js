import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { createClient } from 'redis';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createServer } = require('./index.js');

const PORT = 8091;
const REDIS_URL = 'redis://localhost:6379';

let wss, redisClient;

function connect(roomCode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}?room=${roomCode}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Listen for a message matching filter, with timeout
function listen(ws, filter, timeout = 3000) {
  return Promise.race([
    new Promise(resolve => {
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (!filter || filter(msg)) {
          ws.off('message', handler);
          resolve(msg);
        }
      };
      ws.on('message', handler);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), timeout))
  ]);
}

// Collect all messages over a duration
function collect(ws, duration = 500) {
  return new Promise(resolve => {
    const msgs = [];
    const handler = (data) => msgs.push(JSON.parse(data.toString()));
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(msgs); }, duration);
  });
}

async function cleanRoom(roomCode) {
  // Use SMEMBERS + explicit key construction instead of KEYS (O(N) scan, blocked in Cluster)
  const tabIds = await redisClient.sMembers(`{room:${roomCode}}:tabs`);
  const keys = [
    `{room:${roomCode}}:tabs`,
    `{room:${roomCode}}:transport`,
    ...tabIds.map(id => `{room:${roomCode}}:tab:${id}`)
  ];
  await redisClient.del(keys);
}

describe('WebSocket Relay Server', () => {
  beforeAll(async () => {
    redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    wss = createServer({ port: PORT, redisClient });
    await new Promise(r => setTimeout(r, 200));
  });

  afterAll(async () => {
    if (wss) {
      wss.clients.forEach(c => c.terminate());
      await new Promise(r => wss.close(r));
    }
    if (redisClient) await redisClient.quit();
  });

  // ── Connection ────────────────────────────────────────────

  it('rejects connections without a room code', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const code = await new Promise(resolve => ws.on('close', resolve));
    expect(code).toBe(4001);
  });

  it('rejects too-short room codes', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}?room=AB`);
    const code = await new Promise(resolve => ws.on('close', resolve));
    expect(code).toBe(4001);
  });

  it('accepts valid room codes', async () => {
    const ws = await connect('VALID');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('normalizes room codes to uppercase', async () => {
    const room = 'NORM' + Date.now();
    const ws1 = await connect(room.toLowerCase());
    const ws2 = await connect(room);

    const promise = listen(ws1, m => m.type === 'announce');
    await new Promise(r => setTimeout(r, 50));
    ws2.send(JSON.stringify({ type: 'announce', tabId: 'tn', name: 'T', color: '#fff', state: {} }));

    const msg = await promise;
    expect(msg.tabId).toBe('tn');
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  it('rejects 5th connection to a room (4-tab limit)', async () => {
    const room = 'FULL' + Date.now();
    const clients = [];
    for (let i = 0; i < 4; i++) {
      clients.push(await connect(room));
    }

    const ws5 = new WebSocket(`ws://localhost:${PORT}?room=${room}`);
    const code = await new Promise(resolve => ws5.on('close', resolve));
    expect(code).toBe(4002);

    clients.forEach(ws => ws.close());
    await cleanRoom(room);
  });

  // ── Message Relay ─────────────────────────────────────────

  it('forwards messages to other clients in the same room', async () => {
    const room = 'FWD' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    const promise = listen(ws2, m => m.type === 'announce');
    await new Promise(r => setTimeout(r, 50));
    ws1.send(JSON.stringify({ type: 'announce', tabId: 'ta', name: 'Pinhead', color: '#FF6B6B', state: { grid: [] } }));

    const msg = await promise;
    expect(msg.name).toBe('Pinhead');
    expect(msg.tabId).toBe('ta');
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  it('does NOT echo messages back to sender', async () => {
    const room = 'ECHO' + Date.now();
    const ws1 = await connect(room);

    const msgs = collect(ws1, 500);
    ws1.send(JSON.stringify({ type: 'announce', tabId: 'solo', name: 'T', color: '#000', state: {} }));
    const collected = await msgs;
    expect(collected.find(m => m.type === 'announce')).toBeUndefined();
    ws1.close();
    await cleanRoom(room);
  });

  it('does NOT forward messages across rooms', async () => {
    const r1 = 'RA' + Date.now();
    const r2 = 'RB' + Date.now();
    const ws1 = await connect(r1);
    const ws2 = await connect(r2);

    const msgs = collect(ws2, 500);
    ws1.send(JSON.stringify({ type: 'announce', tabId: 'x', name: 'T', color: '#000', state: {} }));
    const collected = await msgs;
    expect(collected.find(m => m.tabId === 'x')).toBeUndefined();
    ws1.close(); ws2.close();
    await cleanRoom(r1); await cleanRoom(r2);
  });

  // ── Redis Persistence (RedisJSON) ──────────────────────────

  it('stores tab state in Redis as JSON on announce', async () => {
    const room = 'STORE' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({
      type: 'announce', tabId: 'ts', name: 'Chatterer', color: '#4ECDC4',
      state: { grid: [[1, 0, 1]] }
    }));
    await new Promise(r => setTimeout(r, 500));

    const data = await redisClient.json.get(`{room:${room}}:tab:ts`);
    expect(data).not.toBeNull();
    expect(data.name).toBe('Chatterer');
    expect(data.state.grid).toEqual([[1, 0, 1]]);
    ws.close();
    await cleanRoom(room);
  });

  it('sends existing room state to new joiners', async () => {
    const room = 'JOINER' + Date.now();
    const ws1 = await connect(room);

    ws1.send(JSON.stringify({
      type: 'announce', tabId: 'te', name: 'Dreamer', color: '#FFE66D', state: { bpm: 120 }
    }));
    await new Promise(r => setTimeout(r, 500));

    const ws2 = await connect(room);
    const msg = await listen(ws2, m => m.type === 'room-state');
    expect(msg.tabs['te']).toBeDefined();
    expect(msg.tabs['te'].name).toBe('Dreamer');
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  it('removes tab state from Redis after disconnect', async () => {
    const room = 'ORPHAN' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({
      type: 'announce', tabId: 'to', name: 'Gasp', color: '#A78BFA',
      state: { pattern: [1, 1, 0, 0] }
    }));
    await new Promise(r => setTimeout(r, 500));
    ws.close();
    await new Promise(r => setTimeout(r, 300));

    const data = await redisClient.json.get(`{room:${room}}:tab:to`).catch(() => null);
    expect(data).toBeNull();
    const members = await redisClient.sMembers(`{room:${room}}:tabs`);
    expect(members).not.toContain('to');
    await cleanRoom(room);
  });

  // ── State Updates ────────────────────────────────────────

  it('persists state-update via RedisJSON partial update', async () => {
    const room = 'UPDATE' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({
      type: 'announce', tabId: 'tu', name: 'Spike', color: '#FF6B6B',
      state: { bpm: 120 }
    }));
    await new Promise(r => setTimeout(r, 500));

    ws.send(JSON.stringify({
      type: 'state-update', tabId: 'tu',
      state: { bpm: 140, grid: [[1, 1, 0]] }
    }));
    await new Promise(r => setTimeout(r, 500));

    const data = await redisClient.json.get(`{room:${room}}:tab:tu`);
    expect(data).not.toBeNull();
    expect(data.name).toBe('Spike'); // name preserved
    expect(data.color).toBe('#FF6B6B'); // color preserved
    expect(data.state.bpm).toBe(140);
    expect(data.state.grid).toEqual([[1, 1, 0]]);
    ws.close();
    await cleanRoom(room);
  });

  it('forwards state-update to other clients', async () => {
    const room = 'FWDUPD' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    const promise = listen(ws2, m => m.type === 'state-update');
    await new Promise(r => setTimeout(r, 50));
    ws1.send(JSON.stringify({
      type: 'state-update', tabId: 'tu2',
      state: { bpm: 160 }
    }));

    const msg = await promise;
    expect(msg.type).toBe('state-update');
    expect(msg.state.bpm).toBe(160);
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  // ── Transport Sync ──────────────────────────────────────

  it('forwards transport messages to other clients', async () => {
    const room = 'TRANS' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    const promise = listen(ws2, m => m.type === 'transport');
    await new Promise(r => setTimeout(r, 50));
    ws1.send(JSON.stringify({ type: 'transport', tabId: 'tt', action: 'play' }));

    const msg = await promise;
    expect(msg.action).toBe('play');
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  it('forwards BPM transport changes', async () => {
    const room = 'BPM' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    const promise = listen(ws2, m => m.type === 'transport' && m.action === 'bpm');
    await new Promise(r => setTimeout(r, 50));
    ws1.send(JSON.stringify({ type: 'transport', tabId: 'tb', action: 'bpm', value: 140 }));

    const msg = await promise;
    expect(msg.value).toBe(140);
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  it('persists transport play state in Redis', async () => {
    const room = 'TPLAY' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'play' }));
    await new Promise(r => setTimeout(r, 500));

    const t = await redisClient.json.get(`{room:${room}}:transport`);
    expect(t).not.toBeNull();
    expect(t.playing).toBe(true);
    ws.close();
    await cleanRoom(room);
  });

  it('persists transport stop state in Redis', async () => {
    const room = 'TSTOP' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'play' }));
    await new Promise(r => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'stop' }));
    await new Promise(r => setTimeout(r, 300));

    const t = await redisClient.json.get(`{room:${room}}:transport`);
    expect(t.playing).toBe(false);
    ws.close();
    await cleanRoom(room);
  });

  it('persists transport BPM in Redis', async () => {
    const room = 'TBPM' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'bpm', value: 160 }));
    await new Promise(r => setTimeout(r, 500));

    const t = await redisClient.json.get(`{room:${room}}:transport`);
    expect(t.bpm).toBe(160);
    ws.close();
    await cleanRoom(room);
  });

  it('updates transport step via beat-sync without overwriting other fields', async () => {
    const room = 'TBEAT' + Date.now();
    const ws = await connect(room);

    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'play' }));
    await new Promise(r => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'transport', tabId: 'tp', action: 'beat-sync', step: 7 }));
    await new Promise(r => setTimeout(r, 300));

    const t = await redisClient.json.get(`{room:${room}}:transport`);
    expect(t.playing).toBe(true);
    expect(t.step).toBe(7);
    ws.close();
    await cleanRoom(room);
  });

  it('includes transport state in room-state for new joiners', async () => {
    const room = 'TJOIN' + Date.now();
    const ws1 = await connect(room);

    ws1.send(JSON.stringify({ type: 'announce', tabId: 'tj1', name: 'A', color: '#fff', state: {} }));
    await new Promise(r => setTimeout(r, 300));
    ws1.send(JSON.stringify({ type: 'transport', tabId: 'tj1', action: 'play' }));
    await new Promise(r => setTimeout(r, 300));
    ws1.send(JSON.stringify({ type: 'transport', tabId: 'tj1', action: 'bpm', value: 140 }));
    await new Promise(r => setTimeout(r, 300));

    const ws2 = await connect(room);
    const msg = await listen(ws2, m => m.type === 'room-state');
    expect(msg.transport).not.toBeNull();
    expect(msg.transport.playing).toBe(true);
    expect(msg.transport.bpm).toBe(140);
    ws1.close(); ws2.close();
    await cleanRoom(room);
  });

  // ── Session Snapshots ────────────────────────────────────

  it('cleans room state after all clients disconnect', async () => {
    const room = 'SNAP' + Date.now();
    const ws1 = await connect(room);

    ws1.send(JSON.stringify({
      type: 'announce', tabId: 'ts1', name: 'Cowboy', color: '#FFE66D',
      state: { bpm: 130, grid: [[1, 0, 1, 0]] }
    }));
    await new Promise(r => setTimeout(r, 500));

    ws1.close();
    await new Promise(r => setTimeout(r, 300));

    const ws2 = await connect(room);
    let gotRoomState = false;
    const timeout = new Promise(r => setTimeout(() => r(null), 500));
    const msgPromise = new Promise(resolve => {
      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'room-state') {
          gotRoomState = true;
          resolve(msg);
        }
      });
    });
    const result = await Promise.race([msgPromise, timeout]);
    if (gotRoomState && result) {
      expect(Object.keys(result.tabs)).toHaveLength(0);
    }
    ws2.close();
    await cleanRoom(room);
  });

  // ── Leave Notification ────────────────────────────────────

  it('broadcasts leave when a client disconnects', async () => {
    const room = 'LEAVE' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    ws1.send(JSON.stringify({ type: 'announce', tabId: 'tl', name: 'Bound', color: '#fff', state: {} }));
    await new Promise(r => setTimeout(r, 300));

    const promise = listen(ws2, m => m.type === 'leave');
    ws1.close();

    const msg = await promise;
    expect(msg.type).toBe('leave');
    expect(msg.tabId).toBe('tl');
    ws2.close();
    await cleanRoom(room);
  });

  // ── Room-state filtering ────────────────────────────────

  it('filters room-state to only active WS connections', async () => {
    const room = 'FILTER' + Date.now();
    const ws1 = await connect(room);

    ws1.send(JSON.stringify({
      type: 'announce', tabId: 'tf1', name: 'A', color: '#fff', state: {}
    }));
    await new Promise(r => setTimeout(r, 300));

    // Manually inject a stale tab into Redis
    await redisClient.sAdd(`{room:${room}}:tabs`, 'stale-tab');
    await redisClient.json.set(`{room:${room}}:tab:stale-tab`, '$', {
      tabId: 'stale-tab', name: 'Ghost', color: '#000', state: {}
    });

    const ws2 = await connect(room);
    const msg = await listen(ws2, m => m.type === 'room-state');

    // Should include tf1 (active) but NOT stale-tab (no WS connection)
    expect(msg.tabs['tf1']).toBeDefined();
    expect(msg.tabs['stale-tab']).toBeUndefined();

    ws1.close(); ws2.close();
    await new Promise(r => setTimeout(r, 200));

    // Stale tab should have been cleaned up
    const staleData = await redisClient.json.get(`{room:${room}}:tab:stale-tab`).catch(() => null);
    expect(staleData).toBeNull();

    await cleanRoom(room);
  });

  // ── Reconnect ────────────────────────────────────────────

  it('reconnect: fresh state, no orphans', async () => {
    const room = 'RECON' + Date.now();
    const ws1 = await connect(room);

    ws1.send(JSON.stringify({
      type: 'announce', tabId: 'tr1', name: 'Face', color: '#FF6B6B', state: { v: 1 }
    }));
    await new Promise(r => setTimeout(r, 300));

    // Disconnect
    ws1.close();
    await new Promise(r => setTimeout(r, 300));

    // Reconnect with new tabId (as the real client does)
    const ws2 = await connect(room);
    ws2.send(JSON.stringify({
      type: 'announce', tabId: 'tr2', name: 'Face', color: '#FF6B6B', state: { v: 2 }
    }));
    await new Promise(r => setTimeout(r, 300));

    // Verify old tab is gone, new tab exists
    const members = await redisClient.sMembers(`{room:${room}}:tabs`);
    expect(members).not.toContain('tr1');
    expect(members).toContain('tr2');

    ws2.close();
    await cleanRoom(room);
  });

  // ── Redis key cleanup ────────────────────────────────────

  it('no orphaned Redis keys after all tabs leave', async () => {
    const room = 'CLEAN' + Date.now();
    const ws1 = await connect(room);
    const ws2 = await connect(room);

    ws1.send(JSON.stringify({ type: 'announce', tabId: 'tc1', name: 'A', color: '#fff', state: {} }));
    ws2.send(JSON.stringify({ type: 'announce', tabId: 'tc2', name: 'B', color: '#000', state: {} }));
    ws1.send(JSON.stringify({ type: 'transport', tabId: 'tc1', action: 'play' }));
    await new Promise(r => setTimeout(r, 500));

    ws1.close();
    ws2.close();
    await new Promise(r => setTimeout(r, 500));

    // Tab data keys should be cleaned up on disconnect
    const tabKeys = await redisClient.keys(`{room:${room}}:tab:*`);
    expect(tabKeys).toHaveLength(0);

    // Tabs set should have no members (or not exist)
    const members = await redisClient.sMembers(`{room:${room}}:tabs`);
    expect(members).toHaveLength(0);

    // Transport key may still exist (TTL-based cleanup) — that's OK
    await cleanRoom(room);
  });
});
