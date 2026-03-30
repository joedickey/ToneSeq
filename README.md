# ToneSeq

Browser-based step sequencer and drum machine with live pattern switching, graph visualization, and collaborative jam sessions.

## Quick Start

**Play it now:** [toneseq.com](https://toneseq.com/)

Or clone and open `index.html` directly — no build step, no server required. All sequencer, drum machine, and pattern features work offline.

### Local development (with jam sessions)

Jam sessions require an HTTP server (for CORS), a WebSocket server, and Redis:

```bash
# 1. Start Redis (needs JSON module — use Redis Stack or Redis 8.0+)
brew services start redis          # macOS
# or: docker run -p 6379:6379 redis/redis-stack-server:latest

# 2. Start the WebSocket server
cd server
cp .env.example .env               # edit REDIS_URL if needed
npm install
npm start                          # ws://localhost:8080

# 3. Serve the frontend (any static server works)
cd ..
python3 -m http.server 3000        # http://localhost:3000
```

Open `http://localhost:3000` in multiple tabs to test jam sessions.

## Features

**Sequencer**
- 16-step polyphonic note grid
- 3 waveforms (sine, square, saw)
- Adjustable octave and root note (all 12 keys)
- Forward, reverse, and ping-pong playback

**Drum Machine**
- 6 instruments (kick, snare, hi-hat, open hat, clap, tom)
- Per-track volume sliders and mute buttons
- Independent playback direction or linked to sequencer

**Effects & Envelope**
- Filter with LP/HP modes, frequency and resonance controls
- Reverb with send level and decay length
- Full ADSR envelope shaping

**Automation**
- SEQ mode on any parameter (filter, reverb, ADSR)
- Per-step value bars with visual feedback
- Active automation shown in section tabs

**Pattern Bank**
- Save, switch, and delete patterns (up to 6 each for notes and drums)
- Loop-boundary queuing — pattern switches take effect at the next loop start
- Graph thumbnails show pattern content at a glance

**Jam Sessions**
- Real-time collaborative sessions via WebSocket
- Up to 4 tabs per room with automatic peer discovery
- Transport sync (play/stop/BPM) across all participants
- Same-browser tabs sync via BroadcastChannel for zero-latency coordination
- Auto-reconnect with exponential backoff
- Works without a server — solo mode is always available

**Save & Share**
- Full session state persists in the URL hash — bookmark or share a link to restore everything
- Captures all patterns, control settings, waveforms, and playback modes

**Visualization**
- Cytoscape.js graph of active and saved patterns
- Note nodes and drum ring indicators
- Pattern thumbnails in the graph for quick identification

## Controls Reference

| Action | How |
|---|---|
| Toggle a note/drum step | Click the grid cell |
| Paint multiple cells | Click and drag across the grid |
| Save (update active pattern) | Click **Save** |
| Save as new pattern | Click **+** |
| Queue a pattern switch | Tap a pattern thumbnail (takes effect at loop boundary) |
| Delete a pattern | Long-press a thumbnail, then tap again to confirm |
| Automate a parameter | Click **SEQ** next to any slider |
| Randomize current tab | Click **Rnd** |
| Clear current tab | Click **Clr** |
| Clear everything | Click **Clear All** in the controls panel |
| Show/hide controls | Click **Controls** toggle in the header |
| Start a jam session | Click **Jam** → **Start Session** |
| Join a jam session | Click **Jam** → enter room code → **Join** |
| Leave a jam session | Click **Jam** → **Leave** |

## Jam Server

The WebSocket server requires Node.js 18+ and Redis with JSON module support. See [Local development](#local-development-with-jam-sessions) above for setup steps. Compatible Redis options:

- **Redis Stack** (local dev): `brew install redis-stack-server` or Docker
- **Redis 8.0+** (JSON bundled natively)
- **Redis Cloud** with JSON module enabled

The server validates RedisJSON availability on startup and exits with a clear error if it's missing. Solo mode works without any backend.

## Tech

Built with [Tone.js](https://tonejs.github.io/) for audio synthesis and [Cytoscape.js](https://js.cytoscape.org/) for graph visualization. Pure HTML/CSS/JS — no framework, no build step, no server (except for optional jam sessions).

## Support

If you enjoy ToneSeq, consider [buying me a coffee](https://buymeacoffee.com/toneseq). Found a bug or have a feature request? [Open an issue](https://github.com/joedickey/ToneSeq/issues/new).

## Note

Best experienced on desktop in Chrome, Firefox, or Safari. The interface is designed for full-screen desktop use.
