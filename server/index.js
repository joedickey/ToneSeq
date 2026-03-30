'use strict';

const { WebSocketServer } = require('ws');
const redis = require('redis');
const { Room } = require('./room');

const DEFAULT_PORT = 8080;
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const MAX_TABS_PER_ROOM = 4;
const HEARTBEAT_INTERVAL = 30000;

// ── Logging ────────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

function log(level, msg, data) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) entry.data = data;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(entry));
}

// ── Broadcast to local WebSocket clients ───────────────────

function broadcast(localClients, roomCode, message, excludeWs) {
  const room = localClients.get(roomCode);
  if (!room) return;
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [ws] of room) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ── Message handlers (msg, ctx) → Promise ─────────────────

const messageHandlers = {
  announce: async (msg, { room, meta }) => {
    if (!msg.tabId) return;
    meta.tabId = msg.tabId;
    await room.addTab(msg.tabId, {
      tabId: msg.tabId,
      name: msg.name,
      color: msg.color,
      state: msg.state || null
    });
  },

  'state-update': async (msg, { room }) => {
    if (!msg.tabId) return;
    await room.updateTabState(msg.tabId, msg.state);
  },

  edit: async (msg, { room }) => {
    if (!msg.source) return;
    await room.updateTabLastEdit(msg.source, msg);
  },

  transport: async (msg, { room }) => {
    const transportActions = {
      play:        () => room.updateTransportField('$.playing', true),
      stop:        () => room.updateTransportField('$.playing', false),
      bpm:         () => room.updateTransportField('$.bpm', msg.value),
      'beat-sync': () => room.updateTransportStep(msg.step),
    };
    const action = transportActions[msg.action];
    if (action) await action();
  },
};

// ── Server factory ─────────────────────────────────────────

function createServer(options = {}) {
  const port = options.port || process.env.PORT || DEFAULT_PORT;
  const pub = options.redisClient;
  const localClients = new Map();

  const wss = new WebSocketServer({ port });

  const heartbeatTimer = setInterval(() => {
    for (const [, room] of localClients) {
      for (const [ws, meta] of room) {
        if (!meta.alive) {
          ws.terminate();
          continue;
        }
        meta.alive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeatTimer));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const roomCode = (url.searchParams.get('room') || '').toUpperCase();

    if (!roomCode || roomCode.length < 3 || roomCode.length > 20) {
      ws.close(4001, 'Invalid room code');
      return;
    }

    if (!localClients.has(roomCode)) localClients.set(roomCode, new Map());
    const roomMap = localClients.get(roomCode);

    if (roomMap.size >= MAX_TABS_PER_ROOM) {
      ws.close(4002, 'Room full');
      return;
    }

    const meta = { tabId: null, alive: true };
    roomMap.set(ws, meta);
    log('info', 'client connected', { room: roomCode, roomSize: roomMap.size });

    const room = new Room(pub, roomCode);

    ws.on('pong', () => { meta.alive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      log('debug', 'message received', { room: roomCode, type: msg.type, tabId: msg.tabId });
      // Broadcast first (low latency), then persist to Redis
      broadcast(localClients, roomCode, msg, ws);

      const handler = messageHandlers[msg.type];
      if (handler) {
        try {
          await handler(msg, { room, meta });
        } catch (err) {
          log('error', 'Redis error in message handler', { room: roomCode, type: msg.type, error: err.message });
        }
      }
    });

    ws.on('close', async () => {
      roomMap.delete(ws);
      log('info', 'client disconnected', { room: roomCode, tabId: meta.tabId, roomSize: roomMap.size });
      if (roomMap.size === 0) localClients.delete(roomCode);

      if (meta.tabId) {
        const leaveMsg = { type: 'leave', tabId: meta.tabId };
        broadcast(localClients, roomCode, leaveMsg);
        try {
          await room.removeTab(meta.tabId);
        } catch (err) {
          log('error', 'Redis error removing tab on disconnect', { room: roomCode, tabId: meta.tabId, error: err.message });
        }
      }
    });

    ws.on('error', () => ws.terminate());

    // Send existing room state to new joiner, filtered to only active connections
    (async () => {
      const roomState = await room.getAllTabs();
      // Filter to only tabs with active WebSocket connections
      const activeTabIds = new Set();
      if (localClients.has(roomCode)) {
        for (const [, m] of localClients.get(roomCode)) {
          if (m.tabId) activeTabIds.add(m.tabId);
        }
      }
      const filteredState = {};
      for (const [tabId, data] of Object.entries(roomState)) {
        if (activeTabIds.has(tabId)) {
          filteredState[tabId] = data;
        } else {
          // Clean up orphaned Redis entry
          room.removeTab(tabId).catch(() => {});
        }
      }

      // Always include transport state for new joiners
      const transport = await room.getTransport();

      if (Object.keys(filteredState).length > 0 || transport) {
        ws.send(JSON.stringify({
          type: 'room-state',
          tabs: filteredState,
          transport: transport || null
        }));
      }
    })();
  });

  log('info', 'WebSocket server listening', { port });
  return wss;
}

// ── Main ───────────────────────────────────────────────────

async function probeRedisJSON(client) {
  try {
    await client.json.set('__redischeck__', '$', 1);
    await client.del('__redischeck__');
  } catch (err) {
    log('error', 'RedisJSON module is not available. The server requires Redis with JSON support.', {
      hint: 'Use Redis Stack (docker run -p 6379:6379 redis/redis-stack-server:latest), Redis 8.0+, or Redis Cloud with JSON enabled.',
      error: err.message
    });
    process.exit(1);
  }
}

async function main() {
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const pub = redis.createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 500, 5000)
    }
  });
  await pub.connect();
  log('info', 'Redis connected', { url: redisUrl });
  await probeRedisJSON(pub);
  const port = process.env.PORT || DEFAULT_PORT;
  const wss = createServer({ port, redisClient: pub });
  return wss;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { createServer, Room };
