'use strict';

const { WebSocketServer } = require('ws');
const redis = require('redis');

const DEFAULT_PORT = 8080;
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const ROOM_TTL = 60 * 60 * 24; // 24 hours
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

// ── Redis helpers (take client as param) ───────────────────

async function saveTabState(redisClient, roomCode, tabId, state) {
  const key = `room:${roomCode}:tab:${tabId}`;
  await redisClient.set(key, JSON.stringify(state));
  await redisClient.expire(key, ROOM_TTL);
  await redisClient.expire(`room:${roomCode}:tabs`, ROOM_TTL);
}

async function getTabState(redisClient, roomCode, tabId) {
  const raw = await redisClient.get(`room:${roomCode}:tab:${tabId}`);
  return raw ? JSON.parse(raw) : null;
}

async function addTabToRoom(redisClient, roomCode, tabId) {
  await redisClient.sAdd(`room:${roomCode}:tabs`, tabId);
  await redisClient.expire(`room:${roomCode}:tabs`, ROOM_TTL);
}

async function removeTabFromRoom(redisClient, roomCode, tabId) {
  await redisClient.sRem(`room:${roomCode}:tabs`, tabId);
  await redisClient.del(`room:${roomCode}:tab:${tabId}`);
}

async function getRoomTabs(redisClient, roomCode) {
  return await redisClient.sMembers(`room:${roomCode}:tabs`);
}

async function getRoomState(redisClient, roomCode) {
  const tabIds = await getRoomTabs(redisClient, roomCode);
  const tabs = {};
  for (const tabId of tabIds) {
    const state = await getTabState(redisClient, roomCode, tabId);
    if (state) tabs[tabId] = state;
  }
  return tabs;
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
    const room = localClients.get(roomCode);

    if (room.size >= MAX_TABS_PER_ROOM) {
      ws.close(4002, 'Room full');
      return;
    }

    const meta = { tabId: null, alive: true };
    room.set(ws, meta);
    log('info', 'client connected', { room: roomCode, roomSize: room.size });

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

      try {
        if (msg.type === 'announce' && msg.tabId) {
          meta.tabId = msg.tabId;
          await addTabToRoom(pub, roomCode, msg.tabId);
          if (msg.state) {
            await saveTabState(pub, roomCode, msg.tabId, {
              tabId: msg.tabId,
              name: msg.name,
              color: msg.color,
              state: msg.state
            });
          }
        }

        if (msg.type === 'state-update' && msg.tabId) {
          const existing = await getTabState(pub, roomCode, msg.tabId);
          if (existing) {
            existing.state = msg.state;
            await saveTabState(pub, roomCode, msg.tabId, existing);
          }
        }

        if (msg.type === 'edit' && msg.source) {
          const existing = await getTabState(pub, roomCode, msg.source);
          if (existing) {
            existing.lastEdit = msg;
            await saveTabState(pub, roomCode, msg.source, existing);
          }
        }
      } catch (err) {
        log('error', 'Redis error in message handler', { room: roomCode, error: err.message });
      }
    });

    ws.on('close', async () => {
      room.delete(ws);
      log('info', 'client disconnected', { room: roomCode, tabId: meta.tabId, roomSize: room.size });
      if (room.size === 0) localClients.delete(roomCode);

      if (meta.tabId) {
        const leaveMsg = { type: 'leave', tabId: meta.tabId };
        broadcast(localClients, roomCode, leaveMsg);
      }
    });

    ws.on('error', () => ws.terminate());

    // Send existing room state to new joiner
    (async () => {
      const roomState = await getRoomState(pub, roomCode);
      if (Object.keys(roomState).length > 0) {
        ws.send(JSON.stringify({
          type: 'room-state',
          tabs: roomState
        }));
      }
    })();
  });

  log('info', 'WebSocket server listening', { port });
  return wss;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const pub = redis.createClient({ url: redisUrl });
  await pub.connect();
  log('info', 'Redis connected', { url: redisUrl });
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

module.exports = { createServer, saveTabState, getTabState, addTabToRoom, removeTabFromRoom, getRoomTabs, getRoomState };
