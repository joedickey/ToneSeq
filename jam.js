'use strict';

// ═══════════════════════════════════════════════════════════
// JAM SESSION — WebSocket connection, session UI, reconnect
// ═══════════════════════════════════════════════════════════

const JAM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JAM_CODE_LENGTH = 5;
const WS_RECONNECT_BASE = 1000;
const WS_RECONNECT_MAX = 16000;
const WS_PORT = 8080;
const WS_URL = `ws://${location.hostname || 'localhost'}:${WS_PORT}`;

const CENOBITE_NAMES = [
  'Pinhead', 'Chatterer', 'Butterball', 'Channard',
  'Dreamer', 'Barbie', 'Spike', 'Angelique',
  'Torso', 'Gasp', 'Weeper', 'Masque',
  'Hunger', 'Alastor', 'Atkins', 'Charun',
  'Bound', 'Crow', 'Face', 'Clown',
  'Cowboy', 'Dixie', 'Baron', 'Balberith'
];

const JAM_COLORS = [
  '#FF6B6B', '#4ECDC4', '#FFE66D',
  '#A78BFA', '#FB923C', '#34D399'
];

// ── State ────────────────────────────────────────────────

let jamWs = null;
let jamRoomCode = null;
let jamTabId = null;
let jamName = null;
let jamColor = null;
let jamReconnectDelay = WS_RECONNECT_BASE;
let jamReconnectTimer = null;
let jamConnected = false;
const jamPeers = new Map(); // tabId -> { name, color, state }
let jamBroadcastTimer = null;

// ── Tab identity ─────────────────────────────────────────

function getOrCreateTabId() {
  let id = sessionStorage.getItem('jamTabId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('jamTabId', id);
  }
  return id;
}

// ── Identity assignment ─────────────────────────────────

function getOrCreateIdentity() {
  let name = sessionStorage.getItem('jamName');
  let color = sessionStorage.getItem('jamColor');
  if (!name) {
    name = pickAvailableName();
    sessionStorage.setItem('jamName', name);
  }
  if (!color) {
    color = pickAvailableColor();
    sessionStorage.setItem('jamColor', color);
  }
  jamName = name;
  jamColor = color;
}

function pickAvailableName() {
  const taken = new Set([...jamPeers.values()].map(p => p.name));
  const available = CENOBITE_NAMES.filter(n => !taken.has(n));
  const pool = available.length > 0 ? available : CENOBITE_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickAvailableColor() {
  const taken = new Set([...jamPeers.values()].map(p => p.color));
  const available = JAM_COLORS.filter(c => !taken.has(c));
  const pool = available.length > 0 ? available : JAM_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Join code generation ─────────────────────────────────

function generateJamCode() {
  let code = '';
  for (let i = 0; i < JAM_CODE_LENGTH; i++) {
    code += JAM_CODE_CHARS[Math.floor(Math.random() * JAM_CODE_CHARS.length)];
  }
  return code;
}

// ── WebSocket connection ─────────────────────────────────

function connectToRoom(roomCode) {
  if (jamWs && (jamWs.readyState === WebSocket.OPEN || jamWs.readyState === WebSocket.CONNECTING)) {
    jamWs.close();
  }

  jamRoomCode = roomCode.toUpperCase();
  jamTabId = getOrCreateTabId();
  getOrCreateIdentity();
  jamPeers.clear();
  sessionStorage.setItem('jamRoom', jamRoomCode);

  const ws = new WebSocket(`${WS_URL}?room=${jamRoomCode}`);
  jamWs = ws;

  ws.onopen = () => {
    jamConnected = true;
    jamReconnectDelay = WS_RECONNECT_BASE;
    updateJamUI('connected');
    initClockSync();

    // Announce this tab to the room
    ws.send(JSON.stringify({
      type: 'announce',
      tabId: jamTabId,
      name: jamName,
      color: jamColor,
      state: typeof serializeSession === 'function' ? serializeSession() : null
    }));
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleJamMessage(msg);
  };

  ws.onclose = (e) => {
    jamConnected = false;
    if (e.code === 4002) {
      updateJamUI('full');
      sessionStorage.removeItem('jamRoom');
      return;
    }
    if (jamRoomCode) {
      updateJamUI('reconnecting');
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (jamReconnectTimer) clearTimeout(jamReconnectTimer);
  jamReconnectTimer = setTimeout(() => {
    if (jamRoomCode) {
      connectToRoom(jamRoomCode);
    }
  }, jamReconnectDelay);
  jamReconnectDelay = Math.min(jamReconnectDelay * 2, WS_RECONNECT_MAX);
}

function disconnectJam() {
  jamRoomCode = null;
  sessionStorage.removeItem('jamRoom');
  if (jamReconnectTimer) {
    clearTimeout(jamReconnectTimer);
    jamReconnectTimer = null;
  }
  if (jamWs) {
    jamWs.close();
    jamWs = null;
  }
  jamConnected = false;
  jamPeers.clear();
  teardownClockSync();
  updateJamUI('disconnected');
}

// ── State broadcast (debounced) ───────────────────────────

function scheduleJamBroadcast() {
  if (!jamConnected || !jamWs) return;
  clearTimeout(jamBroadcastTimer);
  jamBroadcastTimer = setTimeout(() => {
    if (!jamConnected || !jamWs) return;
    jamWs.send(JSON.stringify({
      type: 'state-update',
      tabId: jamTabId,
      state: typeof serializeSession === 'function' ? serializeSession() : null
    }));
  }, 200);
}

// ── Transport sync ────────────────────────────────────────

let jamTransportRemote = false; // guard against broadcast loops

function jamSendTransport(action, value) {
  if (!jamConnected || !jamWs || jamTransportRemote) return;
  jamWs.send(JSON.stringify({
    type: 'transport',
    tabId: jamTabId,
    action,
    value
  }));
}

function handleRemoteTransport(msg) {
  if (msg.tabId === jamTabId) return;
  jamTransportRemote = true;
  try {
    switch (msg.action) {
      case 'play':
        if (typeof play === 'function') play();
        break;
      case 'stop':
        if (typeof stop === 'function') stop();
        break;
      case 'bpm':
        if (typeof setBPM === 'function' && msg.value) {
          setBPM(msg.value);
          const bpmEl = document.getElementById('bpm');
          if (bpmEl) bpmEl.value = msg.value;
          scheduleHashSync();
        }
        break;
    }
  } finally {
    jamTransportRemote = false;
  }
}

// ── Local clock sync (BroadcastChannel) ───────────────────

let clockChannel = null;
let isClockLeader = false;
let leaderTabId = null;
let leaderElectionTimer = null;

function initClockSync() {
  if (!('BroadcastChannel' in window)) return;
  clockChannel = new BroadcastChannel('jam-clock');

  clockChannel.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'leader-claim':
        // Another tab is claiming leadership
        if (msg.tabId !== jamTabId) {
          leaderTabId = msg.tabId;
          isClockLeader = false;
        }
        break;
      case 'leader-ping':
        // Another tab asking who's here — if we're leader, re-assert
        if (isClockLeader) {
          clockChannel.postMessage({ type: 'leader-claim', tabId: jamTabId });
        }
        break;
      case 'leader-pong':
        // Someone responded to our ping — they exist, let leader-claim resolve it
        break;
      case 'beat-sync':
        // Leader broadcasting beat position — followers align
        if (!isClockLeader && msg.tabId !== jamTabId && typeof Tone !== 'undefined') {
          nudgeTransport(msg);
        }
        break;
      case 'leader-gone':
        // Leader left — elect new one
        if (msg.tabId === leaderTabId) {
          leaderTabId = null;
          tryBecomeLeader();
        }
        break;
    }
  };

  tryBecomeLeader();
}

function tryBecomeLeader() {
  // Wait briefly for existing leader to respond
  clearTimeout(leaderElectionTimer);
  clockChannel.postMessage({ type: 'leader-ping', tabId: jamTabId });
  leaderElectionTimer = setTimeout(() => {
    if (!leaderTabId) {
      isClockLeader = true;
      leaderTabId = jamTabId;
      clockChannel.postMessage({ type: 'leader-claim', tabId: jamTabId });
    }
  }, 200);
}

function broadcastBeatSync(step) {
  if (!isClockLeader || !clockChannel) return;
  clockChannel.postMessage({
    type: 'beat-sync',
    tabId: jamTabId,
    step,
    transportPos: Tone.Transport.seconds,
    bpm: Tone.Transport.bpm.value
  });
}

function nudgeTransport(msg) {
  if (typeof Tone === 'undefined' || !Tone.Transport) return;
  // Only nudge if we're playing and on a different step
  if (typeof isPlaying !== 'undefined' && isPlaying && typeof seqPosition !== 'undefined') {
    // If leader says step 0 and we're not at 0, we're drifting — resync
    if (msg.step === 0 && seqPosition > 1 && seqPosition < 15) {
      // Significant drift detected — snap Transport position
      Tone.Transport.seconds = msg.transportPos;
    }
  }
}

function teardownClockSync() {
  if (clockChannel) {
    if (isClockLeader) {
      clockChannel.postMessage({ type: 'leader-gone', tabId: jamTabId });
    }
    clockChannel.close();
    clockChannel = null;
  }
  isClockLeader = false;
  leaderTabId = null;
}

// ── Message handling ──────────────────────────────────────

function handleJamMessage(msg) {
  switch (msg.type) {
    case 'room-state':
      if (msg.tabs) {
        for (const [id, data] of Object.entries(msg.tabs)) {
          if (id !== jamTabId) {
            jamPeers.set(id, data);
          }
        }
        updatePeerDisplay();
      }
      break;
    case 'announce':
      if (msg.tabId && msg.tabId !== jamTabId) {
        jamPeers.set(msg.tabId, { name: msg.name, color: msg.color, state: msg.state });
        updatePeerDisplay();
      }
      break;
    case 'state-update':
      if (msg.tabId && msg.tabId !== jamTabId) {
        const peer = jamPeers.get(msg.tabId) || {};
        peer.state = msg.state;
        jamPeers.set(msg.tabId, peer);
        updatePeerDisplay();
      }
      break;
    case 'leave':
      if (msg.tabId) {
        jamPeers.delete(msg.tabId);
        updatePeerDisplay();
      }
      break;
    case 'transport':
      handleRemoteTransport(msg);
      break;
  }
}

// ── Peer display ──────────────────────────────────────────

function updatePeerDisplay() {
  const container = document.getElementById('jam-peers');
  if (!container) return;

  if (jamPeers.size === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  for (const [, peer] of jamPeers) {
    const name = peer.name || '?';
    const color = peer.color || '#777';
    html += `<span class="jam-peer" style="--peer-color: ${color};">
      <span class="jam-peer-dot"></span>${name}
    </span>`;
  }
  container.innerHTML = html;
}

// ── UI ───────────────────────────────────────────────────

function updateJamUI(state) {
  const btn = document.getElementById('jam-btn');
  const panel = document.getElementById('jam-panel');
  if (!btn || !panel) return;

  switch (state) {
    case 'connected':
      btn.classList.add('active');
      btn.textContent = 'Jam';
      panel.innerHTML = `
        <div class="jam-connected">
          <span class="jam-code-display">${jamRoomCode}</span>
          <span class="jam-self" style="--peer-color: ${jamColor};">
            <span class="jam-peer-dot"></span>${jamName}
          </span>
          <div id="jam-peers" class="jam-peers"></div>
          <button id="jam-copy-btn" class="jam-action-btn" title="Copy code">Copy</button>
          <button id="jam-leave-btn" class="jam-action-btn jam-leave" title="Leave session">Leave</button>
        </div>
      `;
      panel.style.display = 'flex';
      document.getElementById('jam-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(jamRoomCode).then(() => {
          const btn = document.getElementById('jam-copy-btn');
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      });
      document.getElementById('jam-leave-btn').addEventListener('click', disconnectJam);
      break;

    case 'reconnecting':
      btn.classList.add('active');
      btn.textContent = 'Reconnecting...';
      break;

    case 'full':
      btn.classList.remove('active');
      btn.textContent = 'Jam';
      panel.innerHTML = `<div class="jam-error">Room is full (max 4)</div>`;
      panel.style.display = 'flex';
      setTimeout(() => {
        panel.style.display = 'none';
        panel.innerHTML = '';
        showJamOptions(panel);
      }, 3000);
      break;

    case 'disconnected':
    default:
      btn.classList.remove('active');
      btn.textContent = 'Jam';
      panel.style.display = 'none';
      panel.innerHTML = '';
      break;
  }
}

function showJamOptions(panel) {
  panel.innerHTML = `
    <button id="jam-start-btn" class="jam-action-btn">Start Session</button>
    <div class="jam-join-group">
      <input id="jam-join-input" type="text" maxlength="5" placeholder="CODE" spellcheck="false" autocomplete="off">
      <button id="jam-join-btn" class="jam-action-btn">Join</button>
    </div>
  `;
  panel.style.display = 'flex';

  document.getElementById('jam-start-btn').addEventListener('click', () => {
    const code = generateJamCode();
    connectToRoom(code);
  });

  const joinInput = document.getElementById('jam-join-input');
  const joinBtn = document.getElementById('jam-join-btn');

  joinBtn.addEventListener('click', () => {
    const code = joinInput.value.trim().toUpperCase();
    if (code.length >= 3) connectToRoom(code);
  });

  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const code = joinInput.value.trim().toUpperCase();
      if (code.length >= 3) connectToRoom(code);
    }
  });

  // Auto-uppercase input
  joinInput.addEventListener('input', () => {
    joinInput.value = joinInput.value.toUpperCase();
  });
}

function toggleJamPanel() {
  const panel = document.getElementById('jam-panel');
  if (!panel) return;

  if (jamConnected) {
    // Already connected — clicking toggle should do nothing, panel stays visible
    return;
  }

  if (panel.style.display === 'flex') {
    panel.style.display = 'none';
    panel.innerHTML = '';
  } else {
    showJamOptions(panel);
  }
}

// ── Init ─────────────────────────────────────────────────

function initJam() {
  const btn = document.getElementById('jam-btn');
  if (!btn) return;

  btn.addEventListener('click', toggleJamPanel);

  // Click outside to close panel
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('jam-panel');
    const control = document.querySelector('.jam-control');
    if (panel && panel.style.display === 'flex' && !jamConnected && !control.contains(e.target)) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
  });

  // Auto-reconnect if session exists
  const savedRoom = sessionStorage.getItem('jamRoom');
  if (savedRoom) {
    connectToRoom(savedRoom);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initJam);
} else {
  initJam();
}
