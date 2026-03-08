# ToneSeq QA Report — 2026-03-08

Tested on Chrome via DevTools MCP at: 1440×900 (desktop), 1024×768 (small laptop), 768×1024 (iPad), 480×854 (large phone), 375×667 (iPhone SE).

---

## CRITICAL — Must Fix

### 1. Fixed footer overlaps content at most screen sizes
**Affected:** All sizes except very tall viewports
**What happens:** The `#info-bar` is `position: fixed` at viewport bottom (28px tall). It covers piano roll rows (C#/C4 on mobile), drum section bar buttons (on 1024px), and drum rows (CL hidden at 480px).
**Root cause:** Footer only becomes `position: static` (`docked` class) when user clicks the tiny ▼ hide button — most users won't discover this.
**Fix:** Either (a) add `padding-bottom: 32px` to the last content section to prevent overlap, (b) auto-dock the footer after first scroll, or (c) remove the fixed positioning entirely and let it scroll naturally. Option (c) is simplest.

### 2. Jam reconnection loop traps the user with no cancel/feedback
**Affected:** All sizes, when WS server is unreachable
**What happens:** User clicks "Start Session" → brief "connecting…" flash → panel closes → Jam button stays purple with pulsing dot → reconnection loop runs indefinitely (1s, 2s, 4s… up to 16s backoff) → clicking Jam again doesn't reliably show the panel because reconnect cycle keeps overriding it. No error message displayed. No way to cancel.
**Fix:** (a) Show a persistent `reconnecting` UI state in the panel with room code + "Reconnecting…" + "Leave" button. (b) After N failures (e.g., 3), show "Connection failed" with Leave/Retry buttons. (c) Always allow clicking Jam to expand the panel and show current state.

### 3. Drum section bar overflows on mobile (375px)
**Affected:** 375px and narrower
**What happens:** Section bar `scrollWidth` (427px) exceeds `clientWidth` (375px). The "+" save-new button and ▼ collapse button are clipped off-screen to the right. `scrollbar-width: none` hides any scroll indicator, so users have no idea they can scroll.
**Fix:** Either (a) make the bar scrollable with a visible indicator/shadow on the right edge, (b) move overflow buttons to a second row, or (c) hide less-used buttons behind a "…" menu on small screens.

---

## HIGH — Should Fix

### 4. "Clear All" button overlaps Controls button at 480px
**Affected:** ~400–600px viewport widths
**What happens:** `#clear-btn` is `position: absolute; bottom: 8px; right: 20px` in the header. When controls wrap to multiple rows at mid-widths, Clear All sits on top of the "⚙ Controls ▶" button, obscuring its text.
**Fix:** Remove `position: absolute` from Clear All on mobile and let it flow inline, or move it to a different location at narrow widths.

### 5. No `.catch()` on clipboard.writeText() — silent failure on HTTP
**Affected:** Any non-HTTPS deployment (HTTP, some WebViews)
**What happens:** `navigator.clipboard.writeText()` requires a secure context. If it fails, the promise rejects silently — user clicks Copy and nothing happens, no visual feedback.
**Fix:** Add `.catch()` that falls back to `document.execCommand('copy')` or shows "Copy failed" on the button.

### 6. Room code not clickable to copy
**Affected:** All sizes
**What happens:** The `<span class="jam-code-display">` shows the room code but has `cursor: auto` — it's not interactive. Users naturally expect to tap/click the code to copy it. Only the separate "Copy" button works.
**Fix:** Add `cursor: pointer` and a click handler to `.jam-code-display` that copies and shows feedback (e.g., brief tooltip "Copied!").

### 7. No graceful handling of drum sample load failure
**Affected:** File:// protocol, and potentially HTTP with CORS issues
**What happens:** If drum samples fail to load (CORS, 404, etc.), `Tone.loaded()` rejects. The `await` in the init function throws, but there's no `.catch()`. The Play button stays permanently stuck on "⌛ Loading" (disabled). The entire app becomes non-functional — user can't play anything.
**Fix:** Wrap the init in try/catch. On failure, still enable the Play button (synths work without drum samples). Show a small warning like "Drum samples unavailable" instead of bricking the UI.

---

## MEDIUM — Nice to Fix

### 8. Jam panel dropdown overlaps settings controls on desktop
**Affected:** 1440px with settings panel open
**What happens:** The jam panel dropdown (positioned `top: 100%; right: 0`) overlaps the LEN slider/SEQ button area in the filter/reverb row. Visually the "2.0s SEQ" text gets covered.
**Expected:** Panel should appear above or pushed left if it would overlap controls, or just accept this as normal dropdown behavior.

### 9. Cytoscape style warnings in console
**What happens:** Console shows `The style property 'line-color: #00d4aa40' is invalid` and same for `target-arrow-color`. These hex-with-alpha values may not be supported in the Cytoscape version being used.
**Fix:** Use `rgba()` format instead of 8-digit hex, or update Cytoscape.

### 10. AudioContext autoplay warnings spam console
**What happens:** ~20+ identical warnings: "The AudioContext was not allowed to start." This happens because Tone.js creates the context before user gesture.
**Fix:** Defer `Tone.start()` to the first user interaction (click on Play). This is a known Tone.js pattern. Not user-facing but clutters developer console.

### 11. WS reconnection spams console errors
**What happens:** Each failed reconnect logs both a Chrome-level `ERR_CONNECTION_REFUSED` error and a `Jam WebSocket error` log. At max backoff (16s) this is manageable, but at initial 1s intervals it floods the console.
**Fix:** Reduce logging frequency — only log every Nth failure, or only log on state transitions.

---

## PASS — Working Correctly

- **Desktop 1440px:** All 13 note rows, all 6 drum rows, all controls visible and aligned
- **iPad 768px:** Clean layout, all content visible, no overflow issues
- **Jam Start Session / Join:** Panel opens correctly, input auto-uppercases, Enter key works
- **Jam Connected state:** Room code, identity (name + color dot), Copy button, Leave button all visible and functional on both desktop and mobile
- **Copy button:** Clipboard API works on both desktop and mobile (secure context). "Copied!" feedback appears.
- **Leave button:** Cleanly disconnects, clears state, returns to default Jam button
- **Peer dots:** Visible next to Jam button when connected, show peer colors
- **Section collapse toggles:** Notes/Drums/Graph sections collapse and expand correctly
- **Pattern bank buttons:** Save, Save-new (+), Random, Clear, Mute all accessible in section bars
- **Waveform/playmode buttons:** Correct selected states, proper layout
- **Root note buttons:** All 12 visible, wrap correctly on mobile
- **Octave ±:** Buttons accessible at all sizes
- **Graph section:** Fit button visible, graph area renders

---

---

## SYNC TESTS — All Pass (HTTP localhost, 2 tabs, WS + Redis)

| Test | Result |
|------|--------|
| Peer discovery (tab 1 → tab 2) | **PASS** — Alastor sees Dreamer, Dreamer sees Alastor |
| Identity assignment (unique names/colors) | **PASS** — Different names and colors auto-assigned |
| State broadcast (notes + drums) | **PASS** — Tab 2 received tab 1's grid state via WS |
| Redis persistence (announce) | **PASS** — Full state stored: name, color, grid, synth params, BPM |
| Transport sync (play) | **PASS** — Tab 2 started playing when tab 1 hit play |
| Transport sync (stop) | **PASS** — Tab 2 stopped when tab 1 stopped |
| BPM sync | **PASS** — Tab 2 updated to 140 BPM when tab 1 changed it |
| Session persistence (disconnect + rejoin) | **PASS** — Both tabs disconnected, tab 2 rejoined and received orphaned state from Redis |
| Audio context (HTTP) | **PASS** — Drum samples loaded, Play button enabled, Tone.context runs |
| Audio context (file://) | **FAIL** — CORS blocks drum sample fetch, Play stuck on "Loading" (expected, not a prod issue) |
| Console errors (HTTP) | **PASS** — Zero errors during sync testing |

---

## Summary — Priority Fix Order

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | Fixed footer overlaps content | Critical | Small |
| 2 | Jam reconnect traps user | Critical | Medium |
| 3 | Drum bar overflow on mobile | Critical | Small |
| 4 | Clear All overlaps Controls | High | Small |
| 5 | Clipboard no .catch() | High | Small |
| 6 | Room code not clickable | High | Small |
| 7 | Drum load failure bricks UI | High | Small |
| 8 | Jam panel overlaps settings | Medium | Small |
| 9 | Cytoscape style warnings | Medium | Small |
| 10 | AudioContext spam | Medium | Small |
| 11 | WS reconnect console spam | Medium | Small |
