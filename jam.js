'use strict';

// ═══════════════════════════════════════════════════════════
// JAM SESSION — WebSocket connection, session UI, reconnect
// Decomposed into JamConnection, JamSync, JamUI, JamSession
// ═══════════════════════════════════════════════════════════

(function () {

const JAM_DEBUG = location.search.includes('jam_debug');
function jamLog(...args) { if (JAM_DEBUG) console.log('[JAM]', ...args); }

const JAM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JAM_CODE_LENGTH = 5;
const WS_RECONNECT_BASE = 1000;
const WS_RECONNECT_MAX = 16000;
const WS_MAX_RETRIES = 5;
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

// ── JamConnection — WebSocket lifecycle ─────────────────────

class JamConnection {
  constructor() {
    this.ws = null;
    this.roomCode = null;
    this.tabId = null;
    this.name = null;
    this.color = null;
    this.connected = false;
    this._reconnectDelay = WS_RECONNECT_BASE;
    this._reconnectTimer = null;
    this._reconnectCount = 0;
    this._handlers = new Map(); // type -> [callback]
  }

  on(type, callback) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(callback);
  }

  _emit(type, data) {
    const handlers = this._handlers.get(type);
    if (handlers) handlers.forEach(h => h(data));
  }

  _generateTabId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  _initIdentity(peers) {
    let name = sessionStorage.getItem('jamName');
    let color = sessionStorage.getItem('jamColor');
    if (!name) {
      const taken = new Set([...peers.values()].map(p => p.name));
      const available = CENOBITE_NAMES.filter(n => !taken.has(n));
      const pool = available.length > 0 ? available : CENOBITE_NAMES;
      name = pool[Math.floor(Math.random() * pool.length)];
      sessionStorage.setItem('jamName', name);
    }
    if (!color) {
      const taken = new Set([...peers.values()].map(p => p.color));
      const available = JAM_COLORS.filter(c => !taken.has(c));
      const pool = available.length > 0 ? available : JAM_COLORS;
      color = pool[Math.floor(Math.random() * pool.length)];
      sessionStorage.setItem('jamColor', color);
    }
    this.name = name;
    this.color = color;
  }

  connect(roomCode, peers) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }

    this.roomCode = roomCode.toUpperCase();
    this.tabId = this._generateTabId();
    this._initIdentity(peers);
    sessionStorage.setItem('jamRoom', this.roomCode);

    this._emit('state-change', 'connecting');

    const wsUrl = `${WS_URL}?room=${this.roomCode}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._reconnectDelay = WS_RECONNECT_BASE;
      this._reconnectCount = 0;
      jamLog('connected to room', this.roomCode, 'as', this.name);
      this._emit('state-change', 'connected');
      this._emit('open');
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._emit('message', msg);
    };

    ws.onclose = (e) => {
      this.connected = false;
      if (e.code === 4002) {
        this._emit('state-change', 'full');
        sessionStorage.removeItem('jamRoom');
        return;
      }
      if (this.roomCode) {
        this._reconnectCount++;
        if (this._reconnectCount > WS_MAX_RETRIES) {
          this._emit('state-change', 'failed');
        } else {
          this._emit('state-change', 'reconnecting');
          this._scheduleReconnect(peers);
        }
      }
    };

    ws.onerror = () => {
      jamLog('connection error', WS_URL);
    };
  }

  _scheduleReconnect(peers) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this.roomCode) this.connect(this.roomCode, peers);
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, WS_RECONNECT_MAX);
  }

  disconnect() {
    this.roomCode = null;
    sessionStorage.removeItem('jamRoom');
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this._emit('state-change', 'disconnected');
  }

  send(msg) {
    if (!this.connected || !this.ws) return false;
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    return true;
  }

  resetRetries() {
    this._reconnectCount = 0;
    this._reconnectDelay = WS_RECONNECT_BASE;
  }
}

// ── JamSync — Transport sync, beat sync, leader election ────

class JamSync {
  constructor(connection) {
    this.conn = connection;
    this._clockChannel = null;
    this._isLeader = false;
    this._leaderTabId = null;
    this._leaderElectionTimer = null;
    this._transportRemote = false;
    this._awaitingFirstBeatSync = false;
  }

  get isLeader() { return this._isLeader; }

  initClockSync() {
    if (!('BroadcastChannel' in window)) return;
    this._clockChannel = new BroadcastChannel('jam-clock');

    this._clockChannel.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'leader-claim':
          if (msg.tabId !== this.conn.tabId) {
            this._leaderTabId = msg.tabId;
            this._isLeader = false;
          }
          break;
        case 'leader-ping':
          if (this._isLeader) {
            this._clockChannel.postMessage({ type: 'leader-claim', tabId: this.conn.tabId });
          }
          break;
        case 'beat-sync':
          if (!this._isLeader && msg.tabId !== this.conn.tabId && typeof Tone !== 'undefined') {
            if (this._awaitingFirstBeatSync) {
              // New joiner: snap to leader on first beat-sync
              this._awaitingFirstBeatSync = false;
              if (typeof setSeqPosition === 'function') {
                setSeqPosition(msg.step);
              }
              jamLog('local beat-sync snap to step', msg.step);
            } else {
              this._nudgeTransport(msg);
            }
          }
          break;
        case 'leader-gone':
          if (msg.tabId === this._leaderTabId) {
            this._leaderTabId = null;
            this._tryBecomeLeader();
          }
          break;
      }
    };

    this._tryBecomeLeader();
  }

  _tryBecomeLeader() {
    clearTimeout(this._leaderElectionTimer);
    this._clockChannel.postMessage({ type: 'leader-ping', tabId: this.conn.tabId });
    this._leaderElectionTimer = setTimeout(() => {
      if (!this._leaderTabId) {
        this._isLeader = true;
        this._leaderTabId = this.conn.tabId;
        this._clockChannel.postMessage({ type: 'leader-claim', tabId: this.conn.tabId });
      }
    }, 200);
  }

  broadcastBeatSync(step) {
    if (!this._isLeader || !this._clockChannel) return;
    this._clockChannel.postMessage({
      type: 'beat-sync',
      tabId: this.conn.tabId,
      step,
      transportPos: Tone.Transport.seconds,
      bpm: Tone.Transport.bpm.value
    });

    // Also send over WebSocket for remote tabs (every step)
    this.conn.send({
      type: 'transport',
      tabId: this.conn.tabId,
      action: 'beat-sync',
      step
    });
  }

  sendTransport(action, value) {
    if (this._transportRemote) return;
    this.conn.send({
      type: 'transport',
      tabId: this.conn.tabId,
      action,
      value
    });
  }

  handleTransportMessage(msg) {
    if (msg.tabId === this.conn.tabId) return;
    this._transportRemote = true;
    try {
      switch (msg.action) {
        case 'play':
          if (typeof play === 'function') play();
          break;
        case 'request-sync':
          jamLog('request-sync received, isPlaying=', typeof isPlaying !== 'undefined' ? isPlaying : 'undef');
          if (typeof isPlaying !== 'undefined' && isPlaying && this.conn.ws) {
            this.conn.ws.send(JSON.stringify({
              type: 'transport',
              tabId: this.conn.tabId,
              action: 'sync-state',
              value: {
                playing: true,
                step: typeof seqPosition !== 'undefined' ? seqPosition : 0,
                transportPos: Tone.Transport.seconds,
                bpm: Tone.Transport.bpm.value
              }
            }));
          }
          break;
        case 'sync-state':
          jamLog('sync-state received', msg.value);
          if (msg.value && msg.value.playing) {
            this._applyTransportSync(msg.value);
          }
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
        case 'beat-sync':
          // Remote beat-sync from WS (cross-device)
          if (typeof Tone !== 'undefined') {
            if (this._awaitingFirstBeatSync) {
              this._awaitingFirstBeatSync = false;
              if (typeof setSeqPosition === 'function') {
                setSeqPosition(msg.step);
              }
              jamLog('remote beat-sync snap to step', msg.step);
            } else {
              this._nudgeTransport(msg);
            }
          }
          break;
      }
    } finally {
      this._transportRemote = false;
    }
  }

  // Handle room-state transport for new joiners
  handleRoomTransport(transport) {
    if (!transport) return;
    jamLog('room-state transport', transport);
    if (transport.playing) {
      // Set BPM first
      if (typeof setBPM === 'function' && transport.bpm) {
        setBPM(transport.bpm);
        const bpmEl = document.getElementById('bpm');
        if (bpmEl) bpmEl.value = Math.round(transport.bpm);
      }
      // Start playback, then wait for first beat-sync to snap position
      this._awaitingFirstBeatSync = true;
      if (typeof play === 'function' && typeof isPlaying !== 'undefined' && !isPlaying) {
        play().then(() => {
          // If no beat-sync arrives within 500ms, use the room-state step
          setTimeout(() => {
            if (this._awaitingFirstBeatSync) {
              this._awaitingFirstBeatSync = false;
              if (typeof setSeqPosition === 'function' && transport.step != null) {
                setSeqPosition(transport.step);
              }
              jamLog('fallback: used room-state step', transport.step);
            }
          }, 500);
        });
      }
    }
  }

  _applyTransportSync(value) {
    if (typeof setBPM === 'function' && value.bpm) {
      setBPM(value.bpm);
      const bpmEl = document.getElementById('bpm');
      if (bpmEl) bpmEl.value = Math.round(value.bpm);
    }
    if (typeof play === 'function' && typeof isPlaying !== 'undefined' && !isPlaying) {
      play().then(() => {
        if (typeof setSeqPosition === 'function' && value.step != null) {
          setSeqPosition(value.step);
        }
      });
    } else if (typeof setSeqPosition === 'function' && value.step != null) {
      setSeqPosition(value.step);
    }
  }

  _nudgeTransport(msg) {
    if (typeof Tone === 'undefined' || !Tone.Transport) return;
    if (typeof isPlaying !== 'undefined' && isPlaying && typeof seqPosition !== 'undefined') {
      const stepDiff = Math.abs(msg.step - seqPosition);
      if (stepDiff > 0 && stepDiff < 15 && typeof setSeqPosition === 'function') {
        setSeqPosition(msg.step);
      }
    }
  }

  teardown() {
    if (this._clockChannel) {
      if (this._isLeader) {
        this._clockChannel.postMessage({ type: 'leader-gone', tabId: this.conn.tabId });
      }
      this._clockChannel.close();
      this._clockChannel = null;
    }
    this._isLeader = false;
    this._leaderTabId = null;
    this._awaitingFirstBeatSync = false;
  }
}

// ── JamUI — Peer display, panel, toasts ─────────────────────

class JamUI {
  constructor() {
    this._toastQueue = [];
  }

  showToast(name, action, color) {
    const toast = document.createElement('div');
    toast.className = 'jam-toast';
    toast.innerHTML = `<span class="jam-toast-dot" style="--peer-color: ${color || '#777'};"></span>${name} ${action}`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add('visible');
        setTimeout(() => {
          toast.classList.remove('visible');
          setTimeout(() => toast.remove(), 300);
        }, 2000);
      });
    });
  }

  updatePeerDisplay(selfColor, peers) {
    const dotsContainer = document.getElementById('jam-dots');
    if (dotsContainer) {
      let dots = `<span class="jam-peer-dot" style="--peer-color: ${selfColor};"></span>`;
      for (const [, peer] of peers) {
        dots += `<span class="jam-peer-dot" style="--peer-color: ${peer.color || '#777'};"></span>`;
      }
      dotsContainer.innerHTML = dots;
    }

    const container = document.getElementById('jam-peers');
    if (!container) return;

    let html = '';
    for (const [, peer] of peers) {
      const name = peer.name || '?';
      const color = peer.color || '#777';
      html += `<span class="jam-peer" style="--peer-color: ${color};">
        <span class="jam-peer-dot"></span>${name}
      </span>`;
    }
    container.innerHTML = html;
  }

  resolveColorCollision(connection, peers) {
    const takenColors = new Set([...peers.values()].map(p => p.color));
    if (takenColors.has(connection.color)) {
      const available = JAM_COLORS.filter(c => !takenColors.has(c));
      if (available.length > 0) {
        connection.color = available[Math.floor(Math.random() * available.length)];
        sessionStorage.setItem('jamColor', connection.color);
        // Re-announce with new color
        connection.send({
          type: 'announce',
          tabId: connection.tabId,
          name: connection.name,
          color: connection.color,
          state: typeof serializeSession === 'function' ? serializeSession() : null
        });
      }
    }
  }

  updateState(state, connection, peers, onDisconnect) {
    const btn = document.getElementById('jam-btn');
    const panel = document.getElementById('jam-panel');
    const dotsEl = document.getElementById('jam-dots');
    if (!btn || !panel) return;

    switch (state) {
      case 'connecting':
        btn.classList.add('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) dotsEl.innerHTML = '';
        panel.innerHTML = `
          <div class="jam-connected">
            <span class="jam-code-display">${connection.roomCode}</span>
            <span class="jam-status">connecting…</span>
          </div>
        `;
        panel.style.display = 'flex';
        break;

      case 'connected':
        btn.classList.add('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) dotsEl.style.display = 'flex';
        panel.innerHTML = `
          <div class="jam-connected">
            <span class="jam-code-display">${connection.roomCode}</span>
            <span class="jam-self" style="--peer-color: ${connection.color};">
              <span class="jam-peer-dot"></span>${connection.name}
            </span>
            <div id="jam-peers" class="jam-peers"></div>
            <button id="jam-copy-btn" class="jam-action-btn" title="Copy code">Copy</button>
            <button id="jam-leave-btn" class="jam-action-btn jam-leave" title="Leave session">Leave</button>
          </div>
        `;
        panel.style.display = 'none';
        const copyRoomCode = () => {
          const copyBtn = document.getElementById('jam-copy-btn');
          navigator.clipboard.writeText(connection.roomCode).then(() => {
            if (copyBtn) { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); }
          }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = connection.roomCode;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (copyBtn) { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); }
          });
        };
        document.getElementById('jam-copy-btn').addEventListener('click', copyRoomCode);
        document.querySelector('.jam-code-display').addEventListener('click', copyRoomCode);
        document.getElementById('jam-leave-btn').addEventListener('click', onDisconnect);
        this.updatePeerDisplay(connection.color, peers);
        break;

      case 'reconnecting':
        btn.classList.add('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) { dotsEl.innerHTML = '<span class="jam-reconnecting-dot"></span>'; dotsEl.style.display = 'flex'; }
        panel.innerHTML = `
          <div class="jam-connected">
            <span class="jam-code-display">${connection.roomCode}</span>
            <span class="jam-status">reconnecting…</span>
            <button id="jam-leave-btn" class="jam-action-btn jam-leave" title="Leave session">Leave</button>
          </div>
        `;
        panel.style.display = 'flex';
        document.getElementById('jam-leave-btn').addEventListener('click', onDisconnect);
        break;

      case 'failed':
        btn.classList.add('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) { dotsEl.innerHTML = ''; dotsEl.style.display = 'none'; }
        panel.innerHTML = `
          <div class="jam-connected">
            <span class="jam-status">Connection failed</span>
            <button id="jam-retry-btn" class="jam-action-btn" title="Retry">Retry</button>
            <button id="jam-leave-btn" class="jam-action-btn jam-leave" title="Leave session">Leave</button>
          </div>
        `;
        panel.style.display = 'flex';
        document.getElementById('jam-retry-btn').addEventListener('click', () => {
          connection.resetRetries();
          connection.connect(connection.roomCode, peers);
        });
        document.getElementById('jam-leave-btn').addEventListener('click', onDisconnect);
        break;

      case 'full':
        btn.classList.remove('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) { dotsEl.innerHTML = ''; dotsEl.style.display = 'none'; }
        panel.innerHTML = `<div class="jam-error">Room is full (max 4)</div>`;
        panel.style.display = 'flex';
        setTimeout(() => {
          panel.style.display = 'none';
          panel.innerHTML = '';
        }, 3000);
        break;

      case 'disconnected':
      default:
        btn.classList.remove('active');
        btn.innerHTML = 'Jam';
        if (dotsEl) { dotsEl.innerHTML = ''; dotsEl.style.display = 'none'; }
        panel.style.display = 'none';
        panel.innerHTML = '';
        break;
    }
  }

  showOptions(panel, onStart, onJoin) {
    panel.innerHTML = `
      <button id="jam-start-btn" class="jam-action-btn">Start Session</button>
      <div class="jam-join-group">
        <input id="jam-join-input" type="text" maxlength="5" placeholder="CODE" spellcheck="false" autocomplete="off">
        <button id="jam-join-btn" class="jam-action-btn">Join</button>
      </div>
    `;
    panel.style.display = 'flex';

    document.getElementById('jam-start-btn').addEventListener('click', onStart);

    const joinInput = document.getElementById('jam-join-input');
    const joinBtn = document.getElementById('jam-join-btn');

    joinBtn.addEventListener('click', () => {
      const code = joinInput.value.trim().toUpperCase();
      if (code.length >= 3) onJoin(code);
    });

    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const code = joinInput.value.trim().toUpperCase();
        if (code.length >= 3) onJoin(code);
      }
    });

    joinInput.addEventListener('input', () => {
      joinInput.value = joinInput.value.toUpperCase();
    });
  }
}

// ── JamSession — Facade ────────────────────────────────────

class JamSession {
  constructor() {
    this.conn = new JamConnection();
    this.sync = new JamSync(this.conn);
    this.ui = new JamUI();
    this.peers = new Map();
    this._broadcastTimer = null;

    this._wireEvents();
  }

  _wireEvents() {
    this.conn.on('state-change', (state) => {
      this.ui.updateState(state, this.conn, this.peers, () => this.disconnect());
    });

    this.conn.on('open', () => {
      this.sync.initClockSync();
      // Announce this tab
      this.conn.send({
        type: 'announce',
        tabId: this.conn.tabId,
        name: this.conn.name,
        color: this.conn.color,
        state: typeof serializeSession === 'function' ? serializeSession() : null
      });
      // request-sync as fallback (sent directly to avoid guard)
      setTimeout(() => {
        if (this.conn.ws && this.conn.ws.readyState === WebSocket.OPEN) {
          jamLog('sending request-sync');
          this.conn.ws.send(JSON.stringify({
            type: 'transport',
            tabId: this.conn.tabId,
            action: 'request-sync'
          }));
        }
      }, 300);
    });

    this.conn.on('message', (msg) => this._handleMessage(msg));
  }

  _handleMessage(msg) {
    jamLog('recv', msg.type, msg.tabId || '');
    switch (msg.type) {
      case 'room-state':
        if (msg.tabs) {
          for (const [id, data] of Object.entries(msg.tabs)) {
            if (id !== this.conn.tabId) {
              this.peers.set(id, data);
            }
          }
          this.ui.resolveColorCollision(this.conn, this.peers);
          this.ui.updatePeerDisplay(this.conn.color, this.peers);
        }
        // Handle transport state from room-state (new joiner)
        if (msg.transport) {
          this.sync.handleRoomTransport(msg.transport);
        }
        break;
      case 'announce':
        if (msg.tabId && msg.tabId !== this.conn.tabId) {
          this.peers.set(msg.tabId, { name: msg.name, color: msg.color, state: msg.state });
          this.ui.resolveColorCollision(this.conn, this.peers);
          this.ui.updatePeerDisplay(this.conn.color, this.peers);
          this.ui.showToast(msg.name || 'Someone', 'entered', msg.color);
        }
        break;
      case 'state-update':
        if (msg.tabId && msg.tabId !== this.conn.tabId) {
          const peer = this.peers.get(msg.tabId) || {};
          peer.state = msg.state;
          this.peers.set(msg.tabId, peer);
          this.ui.updatePeerDisplay(this.conn.color, this.peers);
        }
        break;
      case 'leave':
        if (msg.tabId) {
          const leavingPeer = this.peers.get(msg.tabId);
          const leaveName = leavingPeer ? leavingPeer.name : 'Someone';
          const leaveColor = leavingPeer ? leavingPeer.color : '#777';
          this.peers.delete(msg.tabId);
          this.ui.updatePeerDisplay(this.conn.color, this.peers);
          this.ui.showToast(leaveName, 'left', leaveColor);
        }
        break;
      case 'transport':
        this.sync.handleTransportMessage(msg);
        break;
    }
  }

  connect(roomCode) {
    this.peers.clear();
    this.conn.connect(roomCode, this.peers);
  }

  disconnect() {
    this.conn.disconnect();
    this.peers.clear();
    this.sync.teardown();
  }

  scheduleStateBroadcast() {
    if (!this.conn.connected) return;
    clearTimeout(this._broadcastTimer);
    this._broadcastTimer = setTimeout(() => {
      if (!this.conn.connected) return;
      this.conn.send({
        type: 'state-update',
        tabId: this.conn.tabId,
        state: typeof serializeSession === 'function' ? serializeSession() : null
      });
    }, 200);
  }

  togglePanel() {
    const panel = document.getElementById('jam-panel');
    if (!panel) return;

    if (this.conn.connected || this.conn.roomCode) {
      panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
      return;
    }

    if (panel.style.display === 'flex') {
      panel.style.display = 'none';
      panel.innerHTML = '';
    } else {
      this.ui.showOptions(
        panel,
        () => {
          let code = '';
          for (let i = 0; i < JAM_CODE_LENGTH; i++) {
            code += JAM_CODE_CHARS[Math.floor(Math.random() * JAM_CODE_CHARS.length)];
          }
          this.connect(code);
        },
        (code) => this.connect(code)
      );
    }
  }

  init() {
    const btn = document.getElementById('jam-btn');
    if (!btn) return;

    btn.addEventListener('click', () => this.togglePanel());

    document.addEventListener('click', (e) => {
      const panel = document.getElementById('jam-panel');
      const control = document.querySelector('.jam-control');
      if (panel && panel.style.display === 'flex' && !control.contains(e.target)) {
        panel.style.display = 'none';
        if (!this.conn.connected) panel.innerHTML = '';
      }
    });

    // Auto-reconnect if session exists
    const savedRoom = sessionStorage.getItem('jamRoom');
    if (savedRoom) {
      this.connect(savedRoom);
    }
  }
}

// ── Instantiate and expose ──────────────────────────────────

const session = new JamSession();

// Expose for app.js integration (global function API preserved)
window.jamSession = session;
window.jamSendTransport = (action, value) => session.sync.sendTransport(action, value);
window.broadcastBeatSync = (step) => session.sync.broadcastBeatSync(step);
window.scheduleJamBroadcast = () => session.scheduleStateBroadcast();
window.disconnectJam = () => session.disconnect();
window.connectToRoom = (code) => session.connect(code);

// Expose state for app.js reads
Object.defineProperty(window, 'jamConnected', { get: () => session.conn.connected });
Object.defineProperty(window, 'jamRoomCode', { get: () => session.conn.roomCode });
Object.defineProperty(window, 'jamTabId', { get: () => session.conn.tabId });
Object.defineProperty(window, 'jamColor', { get: () => session.conn.color });
Object.defineProperty(window, 'jamPeers', { get: () => session.peers });
Object.defineProperty(window, 'isClockLeader', { get: () => session.sync.isLeader });

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => session.init());
} else {
  session.init();
}

})();
