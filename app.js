'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NUM_ROWS  = 13;   // one octave inclusive (e.g. C4 → C5)
const STEPS     = 16;
const NODE_STACK_SPACING = 52; // px between node centres in a chord stack

// ─── Drum Sequencer Constants ───────────────────────────────
const DRUM_BASE = 'https://raw.githubusercontent.com/joedickey/tr-bot/master/src/audio/';
const DRUM_INSTRUMENTS = [
  { label: 'Perc',  abbr: 'Pe', url: DRUM_BASE + 'trbotperc.mp3'  },
  { label: 'HH2',   abbr: 'H2', url: DRUM_BASE + 'trbothh2.mp3'   },
  { label: 'HH1',   abbr: 'H1', url: DRUM_BASE + 'trbothh1.mp3'   },
  { label: 'Snare', abbr: 'Sn', url: DRUM_BASE + 'trbotsnare.mp3' },
  { label: 'Clap',  abbr: 'Cl', url: DRUM_BASE + 'trbotclap.mp3'  },
  { label: 'Kick',  abbr: 'Kk', url: DRUM_BASE + 'trbotkick.mp3'  },
];
const NUM_DRUM_ROWS = 6;

// ═══════════════════════════════════════════════════════════
// PITCH STATE — drives NOTES / NOTE_LABELS dynamically
// ═══════════════════════════════════════════════════════════

let octaveOffset = 0;   // -2 … +2 (shifts the displayed octave)
let rootSemitone = 0;   // 0=C … 11=B (starting note of the scale)

/** 13 note names, highest (row 0) to lowest (row 12). */
function getCurrentNotes() {
  const baseOctave = 4 + octaveOffset;
  const notes = [];
  for (let i = NUM_ROWS - 1; i >= 0; i--) {
    const semitone = (rootSemitone + i) % 12;
    const octave   = baseOctave + Math.floor((rootSemitone + i) / 12);
    notes.push(`${CHROMATIC[semitone]}${octave}`);
  }
  return notes;
}

/** Display labels: top and bottom rows show octave number, middle rows omit it. */
function getCurrentNoteLabels() {
  return getCurrentNotes().map((note, i) =>
    (i === 0 || i === NUM_ROWS - 1) ? note : note.replace(/\d+$/, '')
  );
}

let NOTES       = getCurrentNotes();
let NOTE_LABELS = getCurrentNoteLabels();

// ═══════════════════════════════════════════════════════════
// AUTOMATION PARAMS CONFIG
// ═══════════════════════════════════════════════════════════

const AUTO_PARAMS = [
  {
    id: 'flt-freq', label: 'Freq', color: '#4da6ff',
    min: 0, max: 100, step: 1, default: 75,
    format: v => formatFreq(freqFromSlider(v)),
    apply: v => { if (filter) filter.frequency.value = freqFromSlider(v); },
  },
  {
    id: 'flt-q', label: 'Res', color: '#a78bfa',
    min: 0.1, max: 12, step: 0.1, default: 1,
    format: v => v.toFixed(1),
    apply: v => { if (filter) filter.Q.value = v; },
  },
  {
    id: 'rvb-send', label: 'Send', color: '#34d399',
    min: 0, max: 0.8, step: 0.01, default: 0,
    format: v => v.toFixed(2),
    apply: v => { if (reverbSend) reverbSend.gain.value = v; },
  },
  {
    id: 'rvb-decay', label: 'Len', color: '#22d3ee',
    min: 0.1, max: 10, step: 0.1, default: 2,
    format: v => v.toFixed(1) + 's',
    apply: v => {
      if (!reverb) return;
      reverb.decay = v;
      clearTimeout(reverbDecayAutoTimer);
      reverbDecayAutoTimer = setTimeout(() => reverb.generate(), 500);
    },
  },
  {
    id: 'adsr-a', label: 'Atk', color: '#fbbf24',
    min: 0.001, max: 2, step: 0.005, default: 0.01,
    format: v => v.toFixed(2) + 's',
    apply: v => setEnvelope('attack', v),
  },
  {
    id: 'adsr-d', label: 'Dec', color: '#f97316',
    min: 0.001, max: 2, step: 0.005, default: 0.1,
    format: v => v.toFixed(2) + 's',
    apply: v => setEnvelope('decay', v),
  },
  {
    id: 'adsr-s', label: 'Sus', color: '#fb923c',
    min: 0, max: 1, step: 0.01, default: 0.5,
    format: v => v.toFixed(2),
    apply: v => setEnvelope('sustain', v),
  },
  {
    id: 'adsr-r', label: 'Rel', color: '#e879f9',
    min: 0.001, max: 5, step: 0.01, default: 0.4,
    format: v => v.toFixed(2) + 's',
    apply: v => setEnvelope('release', v),
  },
];

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

// grid[row][step] = true/false  (row 0 = highest note, row 12 = lowest)
const grid = {};
for (let r = 0; r < NUM_ROWS; r++) { grid[r] = new Array(STEPS).fill(false); }

// Drum state
const drumGrid       = {};
const drumMuted      = {};
const drumPlayers    = {};   // Tone.Buffer instances — used only for URL loading
const drumBuffers    = {};   // raw AudioBuffer per row — used for direct sample-accurate triggering
const drumOffsets    = {};   // per-row leading-silence offset (seconds) to skip MP3 encoder delay
const drumTrackGain  = {};   // raw GainNode per row — per-track volume control
const drumTrackVolume = {};  // 0..1 per row (mirrors drumTrackGain gain value for UI)
let   drumBus        = null; // Tone.Gain — routes all drum tracks through masterVol

// Whole-sequencer mutes
let notesMuted   = false;
let drumSeqMuted = false;
for (let r = 0; r < NUM_DRUM_ROWS; r++) {
  drumGrid[r]  = new Array(STEPS).fill(false);
  drumMuted[r] = false;
}
let drumPlaybackMode    = 'forward';
let drumSeqPosition     = 0;
let drumChordGroups     = new Map();
let drumStepSequence    = [];
let prevDrumPlayingNodes = [];

// chordGroups: Map<step, { notes, nodeIds, anchor, anchorId }>
let chordGroups = new Map();

// stepSequence: [{ step, notes, anchor, … }] in step order
let stepSequence = [];

let synth      = null;
let filter     = null;
let reverbSend = null;
let reverb     = null;
let masterVol  = null;
let loop       = null;
let cy         = null;
let isPlaying  = false;

// Metronome
let metronomeEnabled = false;
let metronomeLoop    = null;
let metronomeSynth   = null;

let prevPlayingNodes = [];

// Automation sequencing state
const autoSeqs = {};              // paramId → Float64Array(16)
const autoActive = new Set();     // paramIds currently in seq mode
let activeTab = 'notes';          // 'notes' | paramId
const prevAutoPlayingNode = {};   // paramId → cy node | null
let reverbDecayAutoTimer = null;

let cellDragState = null; // { type: 'notes'|'drums', activating: bool } — drag-to-paint state

let playbackMode        = 'forward';  // 'forward' | 'reverse' | 'pingpong'
let pendingPlaybackMode = null;
let activeStepArray     = [];
let seqPosition         = 0;
let prevStep            = -1;  // for ping-pong: detect duplicate turnaround steps

// ═══════════════════════════════════════════════════════════
// A. PIANO ROLL
// ═══════════════════════════════════════════════════════════

function buildPianoRoll() {
  const container = document.getElementById('piano-roll');

  // Header: blank label + step numbers
  const blankLabel = document.createElement('div');
  blankLabel.className = 'pr-label';
  container.appendChild(blankLabel);

  for (let s = 0; s < STEPS; s++) {
    const num = document.createElement('div');
    num.className = 'pr-step-num';
    num.textContent = s + 1;
    container.appendChild(num);
  }

  // Note rows — row 0 at top (highest pitch)
  const labels = getCurrentNoteLabels();
  for (let r = 0; r < NUM_ROWS; r++) {
    const lbl = document.createElement('div');
    lbl.className = 'pr-label';
    lbl.dataset.row = r;
    lbl.textContent = labels[r];
    container.appendChild(lbl);

    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('div');
      cell.className = 'step-cell';
      cell.dataset.row  = r;
      cell.dataset.step = s;
      cell.addEventListener('pointerdown', (e) => startCellDrag('notes', r, s, cell, e));
      container.appendChild(cell);
    }
  }
}

function onCellClick(row, step, cell) {
  grid[row][step] = !grid[row][step];
  cell.classList.toggle('active', grid[row][step]);
  updateGraph();
}

// ─── Drag-to-paint for step cells and drum cells ─────────────────────────────

/** Apply a paint state to a single cell without triggering a graph rebuild. */
function applyCell(type, r, s, cell, activating) {
  if (type === 'notes') {
    if (grid[r][s] === activating) return;
    grid[r][s] = activating;
    cell.classList.toggle('active', activating);
  } else {
    if (drumGrid[r][s] === activating) return;
    drumGrid[r][s] = activating;
    cell.classList.toggle('active', activating);
  }
}

function startCellDrag(type, r, s, cell, e) {
  e.preventDefault();
  const activating = type === 'notes' ? !grid[r][s] : !drumGrid[r][s];
  cellDragState = { type, activating };
  applyCell(type, r, s, cell, activating);
}

/** Update only the label text after root/octave change — no DOM rebuild needed. */
function rebuildPianoRollLabels() {
  const labels = getCurrentNoteLabels();
  document.querySelectorAll('.pr-label[data-row]').forEach(el => {
    el.textContent = labels[parseInt(el.dataset.row)];
  });
}

function highlightPlayhead(step) {
  document.querySelectorAll('.step-cell.playhead').forEach(el => el.classList.remove('playhead'));
  document.querySelectorAll(`.step-cell[data-step="${step}"]`).forEach(el => el.classList.add('playhead'));
}

// ═══════════════════════════════════════════════════════════
// B. SEQUENCER (Tone.js)
// ═══════════════════════════════════════════════════════════

/** Logarithmic slider (0–100) → frequency in Hz (20 Hz – 20 kHz). */
function freqFromSlider(v) { return Math.round(20 * Math.pow(1000, v / 100)); }
function formatFreq(hz)    { return hz >= 1000 ? (hz / 1000).toFixed(1) + 'kHz' : hz + 'Hz'; }

/** Build the ordered step array for the current playback mode. */
function getStepArray(mode) {
  const fwd = [...Array(STEPS).keys()];
  if (mode === 'reverse')  return [...fwd].reverse();
  if (mode === 'pingpong') return [...fwd, ...[...fwd].reverse()];
  return fwd;
}

/**
 * Build the repeating 16th-note clock using scheduleRepeat so that
 * activeStepArray can be swapped at loop boundaries without stopping
 * the transport (no timing jolt on mode changes).
 */
function buildLoop() {
  if (loop !== null) { Tone.Transport.clear(loop); loop = null; }
  activeStepArray = getStepArray(playbackMode);
  seqPosition = 0;
  prevStep = -1;

  loop = Tone.Transport.scheduleRepeat((time) => {
    // At the start of each new pass, apply any queued mode change
    if (seqPosition === 0 && pendingPlaybackMode !== null) {
      playbackMode = pendingPlaybackMode;
      pendingPlaybackMode = null;
      activeStepArray = getStepArray(playbackMode);
      prevStep = -1; // reset so first step of new mode is never treated as a duplicate
    }

    const step = activeStepArray[seqPosition];
    const nextPos = (seqPosition + 1) % activeStepArray.length;
    const nextGridStep = activeStepArray[nextPos];
    // Detect ping-pong turnaround: step fires twice in a row only at direction-switch points.
    // Skip audio re-triggers on the duplicate tick to avoid envelope-restart clicks.
    const isDuplicate = (step === prevStep);
    prevStep = step;
    seqPosition = nextPos;

    // Suppress the correct tick at each ping-pong turnaround so every step plays exactly once
    // and the gap between adjacent steps is always exactly 1×16th note (no "hang"):
    //   fwd→rev (step 15): suppress SECOND occurrence (position 16, isDuplicate=true, step≠0)
    //   rev→fwd (step  0): suppress FIRST  occurrence (position 31, seqPosition just wrapped to 0)
    //                      and ALLOW  SECOND occurrence (position 0, isDuplicate=true) to play
    //                      cleanly as the downbeat of the new forward phase.
    const isSuppressedTick =
      (isDuplicate && step !== 0) ||
      (playbackMode === 'pingpong' && !isDuplicate && step === 0 && seqPosition === 0);

    // Collect active notes for this step using current NOTES mapping
    const activeNotes = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      if (grid[r][step]) activeNotes.push(NOTES[r]);
    }
    if (activeNotes.length > 0 && !isSuppressedTick && !notesMuted) {
      // Equal-power polyphony compensation: 1/√n velocity per voice
      const velocity = 1 / Math.sqrt(activeNotes.length);
      synth.triggerAttackRelease(activeNotes, '16n', time, velocity);
    }

    // Apply automation for all active params at this step
    autoActive.forEach(paramId => {
      const seq = autoSeqs[paramId];
      if (!seq) return;
      const cfg = AUTO_PARAMS.find(p => p.id === paramId);
      if (cfg) cfg.apply(seq[step]);
    });

    // Drum step computation and triggering
    let drumStep, drumNextSearchIdx;
    if (drumPlaybackMode === 'link') {
      drumStep = step;
      drumSeqPosition = nextPos;
      drumNextSearchIdx = nextPos; // position in activeStepArray
    } else {
      drumStep = drumSeqPosition;
      const nextDrumPos = (drumSeqPosition + 1) % STEPS;
      drumNextSearchIdx = nextDrumPos; // position in [0..15] forward array (equals step value)
      drumSeqPosition = nextDrumPos;
    }
    // In link mode, drums follow the synth step — use same suppression as synth
    const skipDrumTrigger = drumPlaybackMode === 'link' && isSuppressedTick;
    if (!skipDrumTrigger && !drumSeqMuted) {
      // Create a fresh one-shot AudioBufferSourceNode per hit for sample-accurate scheduling.
      // This bypasses Tone.Player's state machine entirely — the hit lands exactly at `time`.
      const rawCtx = Tone.getContext().rawContext;
      for (let r = 0; r < NUM_DRUM_ROWS; r++) {
        if (!drumMuted[r] && drumGrid[r][drumStep]) {
          const buf = drumBuffers[r];
          if (buf && drumTrackGain[r]) {
            const src = rawCtx.createBufferSource();
            src.buffer = buf;
            src.connect(drumTrackGain[r]); // per-track gain → drumBus → masterVol
            src.start(time, drumOffsets[r] || 0);
          }
        }
      }
    }

    scheduleVisual(() => {
      highlightPlayhead(step);
      // Pass nextPos (array position) so reverse-phase dist is calculated correctly
      updateGraphPlayhead(step, nextPos);
      highlightAutoBarPlayhead(step);
      // Auto graph uses step values directly (no indexOf needed — nodes indexed 0-15)
      autoActive.forEach(paramId => updateAutoGraphPlayhead(paramId, step, nextGridStep));
      highlightDrumPlayhead(drumStep);
      updateDrumGraphPlayhead(drumStep, drumNextSearchIdx);
    }, time);
  }, '16n');
}

function initSynth() {
  synth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 8,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.4 },
  });

  // Signal chain: synth → filter → softLimit → masterVol → destination (dry)
  //                            → reverbSend → reverb → softLimit (wet)
  filter     = new Tone.Filter({ frequency: freqFromSlider(75), type: 'lowpass', Q: 1 });
  reverbSend = new Tone.Gain(0);
  reverb     = new Tone.Reverb({ decay: 2, wet: 1 });
  masterVol  = new Tone.Volume(0);
  const softLimit = new Tone.Compressor({ threshold: -6, ratio: 20, attack: 0.001, release: 0.1, knee: 10 });

  synth.connect(filter);
  filter.connect(softLimit);
  filter.connect(reverbSend);
  reverbSend.connect(reverb);
  reverb.connect(softLimit);
  softLimit.connect(masterVol);
  masterVol.toDestination();

  // Drum bus: raw AudioBufferSourceNodes connect here → masterVol → destination.
  // Fixed −1.5 dB trim on the bus so samples sit slightly below full-scale by default
  // while per-track faders still default to 1.0 (max).
  drumBus = new Tone.Gain(0.841); // 0.841 = 10^(−1.5/20) = −1.5 dB
  drumBus.connect(masterVol);

  // Per-track gain nodes (faders): src → drumTrackGain[r] → drumBus → masterVol
  const rawCtxInit = Tone.getContext().rawContext;
  for (let r = 0; r < NUM_DRUM_ROWS; r++) {
    drumTrackGain[r] = rawCtxInit.createGain();
    drumTrackGain[r].gain.value = 1.0;
    drumTrackVolume[r] = 1.0;
    drumTrackGain[r].connect(drumBus.input);
  }

  buildLoop();
}

// ─── Metronome ──────────────────────────────────────────────

function initMetronome() {
  // Short triangle burst — accented downbeat (beat 1) + quieter off-beats
  metronomeSynth = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.005 },
    volume: -5,
  }).connect(masterVol);
}

function startMetronomeLoop() {
  if (metronomeLoop !== null) { Tone.Transport.clear(metronomeLoop); metronomeLoop = null; }
  // Align the first tick to the next quarter-note boundary so the accent always tracks
  // beat 1 of the global transport clock, even when enabled mid-playback.
  const ppq = Tone.Transport.PPQ;
  const remainder = Tone.Transport.ticks % ppq;
  const startOffset = remainder === 0 ? '+0i' : `+${ppq - remainder}i`;
  metronomeLoop = Tone.Transport.scheduleRepeat((time) => {
    // Derive beat-in-bar from transport ticks — always correct regardless of when enabled
    const beatInBar = Math.floor(Tone.Transport.ticks / ppq) % 4;
    const isDown = beatInBar === 0;
    metronomeSynth.triggerAttackRelease(isDown ? 'B5' : 'E5', 0.03, time, isDown ? 0.75 : 0.45);
  }, '4n', startOffset);
}

function toggleMetronome() {
  metronomeEnabled = !metronomeEnabled;
  document.getElementById('metro-btn').classList.toggle('active', metronomeEnabled);
  if (metronomeEnabled) {
    startMetronomeLoop();
  } else {
    if (metronomeLoop !== null) { Tone.Transport.clear(metronomeLoop); metronomeLoop = null; }
  }
}

/** Switch playback mode. If playing, queues the change for the next loop boundary. */
function setPlaybackMode(mode) {
  if (isPlaying) {
    pendingPlaybackMode = mode;
  } else {
    playbackMode = mode;
    buildLoop();
  }
}

function scheduleVisual(cb, time) {
  if (typeof Tone.getDraw === 'function') {
    try { Tone.getDraw().schedule(cb, time); return; } catch (_) { /* fall through */ }
  }
  requestAnimationFrame(cb);
}

async function play() {
  if (isPlaying) return;
  await Tone.start();
  Tone.Transport.bpm.value = Number(document.getElementById('bpm').value) || 120;
  // Restart metronome loop so beat 1 always lands on the first tick of playback
  if (metronomeEnabled) startMetronomeLoop();
  Tone.Transport.start();
  isPlaying = true;
}

function stop() {
  if (!isPlaying) return;
  Tone.Transport.stop();
  isPlaying = false;
  seqPosition = 0;
  prevStep = -1;
  if (pendingPlaybackMode !== null) {
    playbackMode = pendingPlaybackMode;
    pendingPlaybackMode = null;
    buildLoop();
  }
  document.querySelectorAll('.step-cell.playhead').forEach(el => el.classList.remove('playhead'));
  prevPlayingNodes.forEach(n => n.removeClass('playing'));
  prevPlayingNodes = [];
  const ball = cy && cy.getElementById('__ball__');
  if (ball && ball.length) { ball.stop(); ball.style('opacity', 0); }

  drumSeqPosition = 0;
  document.querySelectorAll('.drum-cell.playhead').forEach(el => el.classList.remove('playhead'));
  prevDrumPlayingNodes.forEach(n => n.removeClass('drum-playing'));
  prevDrumPlayingNodes = [];
  const drumBall = cy && cy.getElementById('__drum-ball__');
  if (drumBall && drumBall.length) { drumBall.stop(); drumBall.style('opacity', 0); }

  document.querySelectorAll('.auto-bar-track.playhead').forEach(el => el.classList.remove('playhead'));
  autoActive.forEach(paramId => {
    if (prevAutoPlayingNode[paramId]) {
      prevAutoPlayingNode[paramId].removeClass('auto-playing');
      prevAutoPlayingNode[paramId] = null;
    }
    const autoBall = cy && cy.getElementById(`__auto-ball-${paramId}__`);
    if (autoBall && autoBall.length) { autoBall.stop(); autoBall.style('opacity', 0); }
  });
}

function setBPM(val) {
  const bpm = parseInt(val, 10);
  if (!isNaN(bpm) && bpm > 0) Tone.Transport.bpm.value = bpm;
}

function setWaveform(type) { synth.set({ oscillator: { type } }); }

function setEnvelope(param, value) { synth.set({ envelope: { [param]: value } }); }

function setMasterVolume(db) {
  if (!masterVol) return;
  if (db <= -40) {
    masterVol.volume.value = -Infinity; // true silence at leftmost position
  } else {
    masterVol.volume.rampTo(db, 0.05);
  }
}

function refreshAutoSeqPanel(paramId) {
  const cfg   = AUTO_PARAMS.find(p => p.id === paramId);
  const panel = document.getElementById(`auto-seq-${paramId}`);
  if (!panel || !cfg || !autoSeqs[paramId]) return;
  const seq = autoSeqs[paramId];
  panel.querySelectorAll('.auto-bar-track').forEach((track, s) => {
    const norm = normalizeAutoValue(paramId, seq[s]);
    const fill = track.querySelector('.auto-bar-fill');
    if (fill) fill.style.height = (norm * 100) + '%';
  });
}

function clearAll() {
  // Clear notes grid
  for (let r = 0; r < NUM_ROWS; r++) grid[r].fill(false);
  document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));
  updateGraph();
  // Reset all active param sequences to default (keep params in seq mode)
  autoActive.forEach(paramId => {
    const cfg = AUTO_PARAMS.find(p => p.id === paramId);
    if (!cfg) return;
    if (!autoSeqs[paramId]) autoSeqs[paramId] = new Float64Array(16);
    autoSeqs[paramId].fill(cfg.default);
    refreshAutoSeqPanel(paramId);
    for (let s = 0; s < 16; s++) updateAutoGraphNode(paramId, s);
  });
  // Clear drum grid
  clearDrumGrid();
}

function clearCurrentSeq() {
  if (activeTab === 'notes') {
    for (let r = 0; r < NUM_ROWS; r++) grid[r].fill(false);
    document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));
    updateGraph();
  } else {
    const paramId = activeTab;
    const cfg = AUTO_PARAMS.find(p => p.id === paramId);
    if (!cfg || !autoSeqs[paramId]) return;
    autoSeqs[paramId].fill(cfg.default);
    refreshAutoSeqPanel(paramId);
    for (let s = 0; s < 16; s++) updateAutoGraphNode(paramId, s);
  }
}

function randomizeAutoSeq(paramId) {
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  if (!cfg) return;
  if (!autoSeqs[paramId]) autoSeqs[paramId] = new Float64Array(16);
  const seq = autoSeqs[paramId];
  // Smooth random walk through param range
  let val = cfg.min + Math.random() * (cfg.max - cfg.min);
  for (let s = 0; s < 16; s++) {
    const target = cfg.min + Math.random() * (cfg.max - cfg.min);
    val = val + (target - val) * 0.45;
    seq[s] = Math.max(cfg.min, Math.min(cfg.max, val));
  }
  refreshAutoSeqPanel(paramId);
  for (let s = 0; s < 16; s++) updateAutoGraphNode(paramId, s);
}

// ─── Random Sequence ───────────────────────────────────────

/**
 * Weighted random sample of k items from pool without replacement.
 * Items with weight 0 are never selected.
 */
function weightedSample(pool, k, weights) {
  const w = [...weights];
  const result = [];
  for (let i = 0; i < k; i++) {
    const total = w.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let rand = Math.random() * total;
    for (let j = 0; j < pool.length; j++) {
      rand -= w[j];
      if (rand <= 0) { result.push(pool[j]); w[j] = 0; break; }
    }
  }
  return result;
}

/**
 * Fill the grid with a musically shaped random sequence:
 *
 *   Steps  — 6–11 active, selected with rhythmic weighting so downbeats
 *             (steps 0, 4, 8, 12) are ~2.5× more likely than weak 16ths.
 *
 *   Contour — one of five melodic arcs (arch, valley, ascend, descend, wave)
 *             chosen at random. The melody line is pulled toward the arc with
 *             a gravity coefficient plus organic noise, so the result follows
 *             the shape without being robotic.
 *
 *   Chords  — ~30 % fewer than before (77 % single-note, 15 % dyad,
 *             6 % triad, 2 % quad). When chords do appear, intervals are
 *             chosen from musically consonant values (minor/major 3rd,
 *             perfect 4th/5th) rather than fully random rows.
 */
function randomSeq() {
  for (let r = 0; r < NUM_ROWS; r++) grid[r].fill(false);
  document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));

  // ── Step selection with rhythmic bias ──────────────────────
  const numSteps   = 6 + Math.floor(Math.random() * 6);           // 6–11
  const stepPool   = [...Array(STEPS).keys()];
  const stepWts    = stepPool.map(s => s % 4 === 0 ? 2.5 : s % 2 === 0 ? 1.2 : 0.7);
  const activeSteps = weightedSample(stepPool, numSteps, stepWts).sort((a, b) => a - b);

  // ── Melodic contour ────────────────────────────────────────
  // Row 0 = highest pitch, row NUM_ROWS-1 = lowest pitch
  const CONTOURS = ['arch', 'valley', 'ascend', 'descend', 'wave'];
  const contour  = CONTOURS[Math.floor(Math.random() * CONTOURS.length)];
  const mid      = (NUM_ROWS - 1) / 2;

  function contourRow(t) {             // t ∈ [0, 1]
    switch (contour) {
      case 'arch':    return mid - (mid - 1) * Math.sin(Math.PI * t);           // rises then falls in pitch
      case 'valley':  return mid + (mid - 1) * Math.sin(Math.PI * t);           // falls then rises
      case 'ascend':  return (NUM_ROWS - 2) - (NUM_ROWS - 3) * t;               // low → high pitch
      case 'descend': return 1 + (NUM_ROWS - 3) * t;                            // high → low pitch
      case 'wave':    return mid + (mid * 0.55) * Math.sin(2.5 * Math.PI * t);  // two+ cycles
      default:        return mid;
    }
  }

  // ── Walk melody with contour gravity + noise ───────────────
  let curRow = Math.round(contourRow(0));

  activeSteps.forEach((step, idx) => {
    const t      = idx / Math.max(activeSteps.length - 1, 1);
    const target = contourRow(t);
    const gravity = (target - curRow) * 0.4;               // pull toward arc
    const noise   = (Math.random() - 0.5) * 3.5;           // organic variation
    curRow = Math.max(0, Math.min(NUM_ROWS - 1, Math.round(curRow + gravity + noise)));

    // ── Note count (30 % fewer chords) ──────────────────────
    const rv = Math.random();
    const noteCount = rv < 0.77 ? 1 : rv < 0.92 ? 2 : rv < 0.98 ? 3 : 4;

    const rows = new Set([curRow]);

    if (noteCount >= 2) {
      // Prefer consonant dyad intervals: m3 (3), M3 (4), P4 (5), P5 (7)
      const iv  = [3, 4, 4, 5, 7][Math.floor(Math.random() * 5)];
      const up  = curRow - iv;   // higher pitch = lower row index
      const dn  = curRow + iv;
      const cnd = (up >= 0) ? up : (dn < NUM_ROWS ? dn : -1);
      if (cnd >= 0 && !rows.has(cnd)) rows.add(cnd);
    }

    if (noteCount >= 3) {
      // Build upward from the highest pitch already in the chord
      const topRow = Math.min(...rows);
      for (const iv of [7, 5, 4, 3]) {
        const cnd = topRow - iv;
        if (cnd >= 0 && !rows.has(cnd)) { rows.add(cnd); break; }
      }
    }

    if (noteCount >= 4) {
      // Octave or 5th doubling below the melody note
      for (const iv of [12, 7]) {
        const cnd = curRow + iv;
        if (cnd < NUM_ROWS && !rows.has(cnd)) { rows.add(cnd); break; }
      }
    }

    rows.forEach(row => {
      grid[row][step] = true;
      const cell = document.querySelector(`.step-cell[data-row="${row}"][data-step="${step}"]`);
      if (cell) cell.classList.add('active');
    });
  });

  updateGraph();
}

// ─── Octave / Root ─────────────────────────────────────────

function setOctave(delta) {
  const next = octaveOffset + delta;
  if (next < -2 || next > 2) return;
  octaveOffset = next;
  NOTES       = getCurrentNotes();
  NOTE_LABELS = getCurrentNoteLabels();
  rebuildPianoRollLabels();
  document.getElementById('oct-display').textContent = 4 + octaveOffset;
  updateGraph();
}

function setRootNote(semitone) {
  rootSemitone = semitone;
  NOTES       = getCurrentNotes();
  NOTE_LABELS = getCurrentNoteLabels();
  rebuildPianoRollLabels();
  updateGraph();
}

// ═══════════════════════════════════════════════════════════
// B2. DRUM SEQUENCER
// ═══════════════════════════════════════════════════════════

async function initDrumSamples() {
  // Use Tone.Buffer (lightweight — just loads/decodes the URL, no Player state machine)
  DRUM_INSTRUMENTS.forEach((inst, row) => {
    drumPlayers[row] = new Tone.Buffer(inst.url);
  });
  const playBtn = document.getElementById('play-btn');
  playBtn.disabled = true;
  playBtn.innerHTML = '&#8987; Loading';
  await Tone.loaded();
  // Extract raw AudioBuffers and detect per-sample leading-silence offset to compensate
  // for MP3 encoder priming delay (~13–26 ms of silence before the actual transient).
  for (let r = 0; r < NUM_DRUM_ROWS; r++) {
    const buf = drumPlayers[r].get();
    drumBuffers[r] = buf;
    drumOffsets[r] = 0;
    if (buf) {
      const data = buf.getChannelData(0);
      const threshold = 0.003; // ~0.3% of full scale
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > threshold) { drumOffsets[r] = i / buf.sampleRate; break; }
      }
    }
  }
  playBtn.disabled = false;
  playBtn.innerHTML = '&#9654; Play';
}

function buildDrumRoll() {
  const body = document.getElementById('drum-body');

  const wrap = document.createElement('div');
  wrap.id = 'drum-roll-wrap';
  body.appendChild(wrap);

  const container = document.createElement('div');
  container.id = 'drum-roll';
  wrap.appendChild(container);

  const muteCol = document.createElement('div');
  muteCol.id = 'drum-mute-col';
  wrap.appendChild(muteCol);

  // Header row: blank label + 16 step numbers
  const blankLabel = document.createElement('div');
  blankLabel.className = 'dr-label';
  container.appendChild(blankLabel);

  for (let s = 0; s < STEPS; s++) {
    const num = document.createElement('div');
    num.className = 'dr-step-num';
    num.textContent = s + 1;
    container.appendChild(num);
  }

  // Mute column header spacer (aligns with step-number header row)
  muteCol.appendChild(document.createElement('div'));

  // Instrument rows
  for (let r = 0; r < NUM_DRUM_ROWS; r++) {
    // Volume slider — horizontal bar with draggable fill, replaces the static label
    const volSlider = document.createElement('div');
    volSlider.className = 'dr-vol-slider';
    volSlider.title = DRUM_INSTRUMENTS[r].label + ' volume';

    const fill = document.createElement('div');
    fill.className = 'dr-vol-fill';
    fill.style.width = (drumTrackVolume[r] * 100) + '%';

    const lbl = document.createElement('span');
    lbl.className = 'dr-vol-text';
    lbl.textContent = DRUM_INSTRUMENTS[r].abbr;

    volSlider.appendChild(fill);
    volSlider.appendChild(lbl);
    container.appendChild(volSlider);

    // Click or drag to set volume — position within bar maps to 0..1
    volSlider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const setVol = (clientX) => {
        const rect = volSlider.getBoundingClientRect();
        const vol = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        drumTrackVolume[r] = vol;
        drumTrackGain[r].gain.setTargetAtTime(vol, Tone.getContext().rawContext.currentTime, 0.01);
        fill.style.width = (vol * 100) + '%';
      };
      setVol(e.clientX);
      const onMove = (me) => setVol(me.clientX);
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    volSlider.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const setVol = (clientX) => {
        const rect = volSlider.getBoundingClientRect();
        const vol = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        drumTrackVolume[r] = vol;
        drumTrackGain[r].gain.setTargetAtTime(vol, Tone.getContext().rawContext.currentTime, 0.01);
        fill.style.width = (vol * 100) + '%';
      };
      setVol(e.touches[0].clientX);
      const onMove = (te) => setVol(te.touches[0].clientX);
      const onEnd = () => { volSlider.removeEventListener('touchmove', onMove); volSlider.removeEventListener('touchend', onEnd); };
      volSlider.addEventListener('touchmove', onMove, { passive: false });
      volSlider.addEventListener('touchend', onEnd);
    }, { passive: false });

    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('div');
      cell.className = 'drum-cell';
      cell.dataset.row  = r;
      cell.dataset.step = s;
      cell.addEventListener('pointerdown', (e) => startCellDrag('drums', r, s, cell, e));
      container.appendChild(cell);
    }

    const muteBtn = document.createElement('button');
    muteBtn.className = 'drum-mute-btn';
    muteBtn.dataset.row = r;
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => toggleDrumMute(r, muteBtn));
    muteCol.appendChild(muteBtn);
  }
}

function onDrumCellClick(row, step, cell) {
  drumGrid[row][step] = !drumGrid[row][step];
  cell.classList.toggle('active', drumGrid[row][step]);
  updateDrumGraph();
}

function toggleDrumMute(row, btn) {
  drumMuted[row] = !drumMuted[row];
  btn.classList.toggle('muted', drumMuted[row]);
  document.querySelectorAll(`.drum-cell[data-row="${row}"]`).forEach(cell => {
    cell.classList.toggle('muted', drumMuted[row]);
  });
}

function clearDrumGrid() {
  for (let r = 0; r < NUM_DRUM_ROWS; r++) drumGrid[r].fill(false);
  document.querySelectorAll('.drum-cell.active').forEach(el => el.classList.remove('active'));
  updateDrumGraph();
}

function randomDrumSeq() {
  // Clear without triggering updateDrumGraph yet
  for (let r = 0; r < NUM_DRUM_ROWS; r++) drumGrid[r].fill(false);
  document.querySelectorAll('.drum-cell.active').forEach(el => el.classList.remove('active'));

  function setDrum(r, s) {
    drumGrid[r][s] = true;
    const cell = document.querySelector(`.drum-cell[data-row="${r}"][data-step="${s}"]`);
    if (cell) cell.classList.add('active');
  }

  // Kick (row 5): Steps 0 & 8 always; ~40% 4,12; ~20% other even; ~8% odd
  setDrum(5, 0); setDrum(5, 8);
  [4, 12].forEach(s => { if (Math.random() < 0.40) setDrum(5, s); });
  for (let s = 0; s < STEPS; s++) {
    if (s === 0 || s === 8 || s === 4 || s === 12) continue;
    if (!drumGrid[5][s]) {
      if (Math.random() < (s % 2 === 0 ? 0.20 : 0.08)) setDrum(5, s);
    }
  }

  // Clap (row 4): Steps 4 & 12 always; ~25% 2,6,10,14; ~8% odd
  setDrum(4, 4); setDrum(4, 12);
  [2, 6, 10, 14].forEach(s => { if (Math.random() < 0.25) setDrum(4, s); });
  for (let s = 0; s < STEPS; s++) {
    if (s % 2 === 0 || drumGrid[4][s]) continue;
    if (Math.random() < 0.08) setDrum(4, s);
  }

  // Snare (row 3): Steps 4 & 12 always; ~25% other even; ~8% odd
  setDrum(3, 4); setDrum(3, 12);
  for (let s = 0; s < STEPS; s++) {
    if (s === 4 || s === 12 || drumGrid[3][s]) continue;
    if (Math.random() < (s % 2 === 0 ? 0.25 : 0.08)) setDrum(3, s);
  }

  // HH1 (row 2): ~80% even; ~30% odd (busy closed hi-hat)
  for (let s = 0; s < STEPS; s++) {
    if (Math.random() < (s % 2 === 0 ? 0.80 : 0.30)) setDrum(2, s);
  }

  // HH2 (row 1): ~25% even; ~10% odd (sparse open hi-hat)
  for (let s = 0; s < STEPS; s++) {
    if (Math.random() < (s % 2 === 0 ? 0.25 : 0.10)) setDrum(1, s);
  }

  // Perc (row 0): ~20% all steps
  for (let s = 0; s < STEPS; s++) {
    if (Math.random() < 0.20) setDrum(0, s);
  }

  updateDrumGraph();
}

function setDrumPlaybackMode(mode) {
  drumPlaybackMode = mode;
}

function highlightDrumPlayhead(step) {
  document.querySelectorAll('.drum-cell.playhead').forEach(el => el.classList.remove('playhead'));
  document.querySelectorAll(`.drum-cell[data-step="${step}"]`).forEach(el => el.classList.add('playhead'));
}

function initDrumSection() {
  buildDrumRoll();
  initDrumSamples();
  document.querySelectorAll('.drum-playmode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.drum-playmode-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setDrumPlaybackMode(btn.dataset.drumMode);
    });
  });
  document.getElementById('drum-random-btn').addEventListener('click', randomDrumSeq);
  document.getElementById('drum-clear-btn').addEventListener('click', clearDrumGrid);
}

// ─── Drum Graph Functions ───────────────────────────────────

function buildDrumChordGroups() {
  const groups = new Map();
  for (let s = 0; s < STEPS; s++) {
    const rows = [];
    for (let r = 0; r < NUM_DRUM_ROWS; r++) {
      if (drumGrid[r][s]) rows.push(r);
    }
    if (rows.length > 0) {
      const nodeIds   = rows.map(r => `drum-${r}-${s}`);
      const anchorIdx = rows.length - 1;
      groups.set(s, { rows, nodeIds, anchorId: nodeIds[anchorIdx], anchor: rows[anchorIdx] });
    }
  }
  return groups;
}

function snapDrumStacks() {
  drumChordGroups.forEach(({ nodeIds, anchorId }, step) => {
    if (nodeIds.length <= 1) return;
    const { x: ax, y: ay } = cy.getElementById(anchorId).position();
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    nodeIds.forEach((id, i) => {
      const stepsOut = nodeIds.length - 1 - i;
      cy.getElementById(id).position({
        x: ax + stepsOut * NODE_STACK_SPACING * dx,
        y: ay + stepsOut * NODE_STACK_SPACING * dy,
      });
    });
  });
}

function updateDrumGraph() {
  if (!cy) return;

  drumChordGroups = buildDrumChordGroups();
  drumStepSequence = [];
  for (let s = 0; s < STEPS; s++) {
    if (drumChordGroups.has(s)) drumStepSequence.push({ step: s, ...drumChordGroups.get(s) });
  }

  const activeIds = new Set([...drumChordGroups.values()].flatMap(g => g.nodeIds));

  // Remove drum edges
  cy.edges().forEach(e => {
    const t = e.data('type');
    if (t === 'drum-stack' || t === 'drum-sequence') e.remove();
  });

  // Stop drum ball, clear playing nodes
  const drumBall = cy.getElementById('__drum-ball__');
  if (drumBall.length) { drumBall.stop(); drumBall.style('opacity', 0); }
  prevDrumPlayingNodes.forEach(n => n.removeClass('drum-playing'));
  prevDrumPlayingNodes = [];

  // Remove stale drum nodes
  cy.nodes().forEach(node => {
    const id = node.id();
    if (!id.startsWith('drum-')) return;
    if (!activeIds.has(id)) node.remove();
  });

  // Manage __drums-center__ label node
  const drumsCenter = cy.getElementById('__drums-center__');
  if (drumStepSequence.length === 0) {
    if (drumsCenter.length) drumsCenter.remove();
  } else if (!drumsCenter.length) {
    cy.add({ data: { id: '__drums-center__', label: 'Drums' }, classes: 'drum-ring-label', position: { x: 0, y: 0 } });
  }

  // Add missing drum nodes
  const containerW = cy.container().clientWidth  || 400;
  const containerH = cy.container().clientHeight || 380;

  drumChordGroups.forEach(({ rows, nodeIds }, step) => {
    rows.forEach((r, i) => {
      const id = nodeIds[i];
      if (cy.getElementById(id).length === 0) {
        const angle = (step / STEPS) * 2 * Math.PI - Math.PI / 2;
        cy.add({
          data: { id, label: DRUM_INSTRUMENTS[r].abbr },
          classes: 'drum-node',
          position: {
            x: containerW / 2 + 100 * Math.cos(angle),
            y: containerH / 2 + 100 * Math.sin(angle),
          },
        });
      }
    });
  });

  // Add drum stack edges
  const stackEdges = [];
  drumChordGroups.forEach(({ nodeIds }, step) => {
    for (let i = 0; i < nodeIds.length - 1; i++) {
      stackEdges.push({
        data: { id: `drum-stack-${step}-${i}`, source: nodeIds[i], target: nodeIds[i + 1], type: 'drum-stack' },
      });
    }
  });

  // Add drum sequence edges
  const seqEdges = [];
  if (drumStepSequence.length >= 2) {
    const dn = drumStepSequence.length;
    drumStepSequence.forEach(({ step, anchorId }, i) => {
      const next = drumStepSequence[(i + 1) % dn];
      let dist = i < dn - 1 ? next.step - step : (STEPS - step) + next.step;
      dist = Math.max(dist, 1);
      seqEdges.push({
        data: { id: `drum-seq-${i}`, source: anchorId, target: next.anchorId, dist, type: 'drum-sequence' },
      });
    });
  }

  if (stackEdges.length || seqEdges.length) cy.add([...stackEdges, ...seqEdges]);
  positionAllRings();
}

function updateDrumGraphPlayhead(drumStep, nextSearchIdx) {
  if (!cy) return;

  prevDrumPlayingNodes.forEach(n => n.removeClass('drum-playing'));
  prevDrumPlayingNodes = [];

  if (!drumChordGroups.has(drumStep)) return;

  drumChordGroups.get(drumStep).nodeIds.forEach(id => {
    const node = cy.getElementById(id);
    if (node.length) { node.addClass('drum-playing'); prevDrumPlayingNodes.push(node); }
  });

  const ball = cy.getElementById('__drum-ball__');
  if (!ball.length || drumStepSequence.length < 2) return;

  const srcGroup = drumChordGroups.get(drumStep);
  if (!srcGroup) return;

  // link: nextSearchIdx is the synth's nextPos (index into activeStepArray, handles ping-pong)
  // forward: nextSearchIdx is the drum's next step value (0-15, index = value in [0..15])
  const searchArray = drumPlaybackMode === 'link' ? activeStepArray : [...Array(STEPS).keys()];
  const sn = searchArray.length;
  let tgtGroup = null;
  let dist = 1;
  for (let i = 0; i < sn; i++) {
    const gs = searchArray[(nextSearchIdx + i) % sn];
    if (drumChordGroups.has(gs)) { tgtGroup = drumChordGroups.get(gs); dist = i + 1; break; }
  }
  if (!tgtGroup) return;

  const srcNode = cy.getElementById(srcGroup.anchorId);
  const tgtNode = cy.getElementById(tgtGroup.anchorId);
  if (!srcNode.length || !tgtNode.length) return;

  const stepMs   = (60 / Tone.Transport.bpm.value / 4) * 1000;
  const duration = Math.max(dist, 1) * stepMs;

  ball.stop();
  ball.position(srcNode.position());
  ball.style('opacity', 1);
  ball.animate({ position: tgtNode.position(), duration, easing: 'linear' });
}

// ═══════════════════════════════════════════════════════════
// C. GRAPH VISUALIZATION (Cytoscape.js)
// ═══════════════════════════════════════════════════════════

function initGraph() {
  cy = cytoscape({
    container: document.getElementById('graph'),
    userZoomingEnabled: true,
    userPanningEnabled: true,
    style: [
      {
        selector: 'node',
        style: {
          'width': 38, 'height': 38,
          'background-color': '#00251e',
          'border-width': 2, 'border-color': '#00d4aa',
          'label': 'data(label)',
          'font-size': '11px', 'font-family': 'monospace',
          'color': '#00d4aa',
          'text-valign': 'center', 'text-halign': 'center',
        },
      },
      {
        selector: 'node.playing',
        style: {
          'background-color': '#2e2500',
          'border-color': '#ffcc00', 'border-width': 2.5,
          'color': '#ffcc00',
        },
      },
      {
        selector: 'edge[type = "sequence"]',
        style: {
          'width': 1.5,
          'line-color': '#00d4aa40',
          'target-arrow-color': '#00d4aa40',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'arrow-scale': 0.75,
        },
      },
      {
        selector: 'node.ball',
        style: {
          'width': 14, 'height': 14,
          'background-color': '#ffcc00',
          'border-width': 2, 'border-color': '#ffaa00',
          'label': '', 'opacity': 0, 'z-index': 999,
        },
      },
      {
        selector: 'edge[type = "chord-stack"]',
        style: {
          'width': 2, 'line-color': '#1a4040',
          'target-arrow-shape': 'none', 'source-arrow-shape': 'none',
          'curve-style': 'straight',
        },
      },
      {
        selector: 'node.auto-node',
        style: {
          'width': 'data(size)', 'height': 'data(size)',
          'background-color': 'data(bgColor)',
          'border-width': 1.5, 'border-color': 'data(color)',
          'label': 'data(label)',
          'font-size': '8px', 'font-family': 'monospace',
          'color': 'data(color)',
          'text-valign': 'center', 'text-halign': 'center',
          'text-wrap': 'none',
        },
      },
      {
        selector: 'node.auto-node.auto-playing',
        style: {
          'border-color': '#ffcc00', 'border-width': 2.5,
          'color': '#ffcc00',
        },
      },
      {
        selector: 'edge[type = "auto-ring"]',
        style: {
          'width': 1,
          'line-color': 'data(edgeColor)',
          'target-arrow-shape': 'none',
          'source-arrow-shape': 'none',
          'curve-style': 'straight',
        },
      },
      {
        selector: 'node.auto-ball',
        style: {
          'width': 10, 'height': 10,
          'background-color': 'data(color)',
          'border-width': 0,
          'label': '', 'opacity': 0, 'z-index': 999,
        },
      },
      {
        selector: 'node.auto-ring-label',
        style: {
          'width': 1, 'height': 1,
          'background-opacity': 0,
          'border-width': 0,
          'label': 'data(label)',
          'font-size': '13px', 'font-weight': 700, 'font-family': 'monospace',
          'color': 'data(dimColor)',
          'text-valign': 'center', 'text-halign': 'center',
        },
      },
      {
        selector: 'node.drum-node',
        style: {
          'width': 30, 'height': 30,
          'background-color': '#2a0a0a',
          'border-width': 2, 'border-color': '#ff6b6b',
          'label': 'data(label)',
          'font-size': '10px', 'font-family': 'monospace',
          'color': '#ff9999',
          'text-valign': 'center', 'text-halign': 'center',
        },
      },
      {
        selector: 'node.drum-node.drum-playing',
        style: {
          'background-color': '#3a1800', 'border-color': '#ffcc00',
          'border-width': 2.5, 'color': '#ffcc00',
        },
      },
      {
        selector: 'node.drum-ball',
        style: {
          'width': 10, 'height': 10,
          'background-color': '#ff6b6b',
          'border-width': 1, 'border-color': '#ff4444',
          'label': '', 'opacity': 0, 'z-index': 999,
        },
      },
      {
        selector: 'node.drum-ring-label',
        style: {
          'width': 1, 'height': 1,
          'background-opacity': 0, 'border-width': 0,
          'label': 'data(label)',
          'font-size': '13px', 'font-weight': 700, 'font-family': 'monospace',
          'color': 'rgba(255,107,107,0.55)',
          'text-valign': 'center', 'text-halign': 'center',
        },
      },
      {
        selector: 'node.notes-ring-label',
        style: {
          'width': 1, 'height': 1,
          'background-opacity': 0, 'border-width': 0,
          'label': 'data(label)',
          'font-size': '13px', 'font-weight': 700, 'font-family': 'monospace',
          'color': 'rgba(0,212,170,0.3)',
          'text-valign': 'center', 'text-halign': 'center',
        },
      },
      {
        selector: 'edge[type = "drum-stack"]',
        style: {
          'width': 2, 'line-color': '#4a1010',
          'target-arrow-shape': 'none', 'source-arrow-shape': 'none',
          'curve-style': 'straight',
        },
      },
      {
        selector: 'edge[type = "drum-sequence"]',
        style: {
          'width': 1.5, 'line-color': '#ff6b6b40',
          'target-arrow-color': '#ff6b6b40', 'target-arrow-shape': 'triangle',
          'curve-style': 'bezier', 'arrow-scale': 0.75,
        },
      },
    ],
    elements: [],
    layout: { name: 'null' },
  });

  cy.add({ data: { id: '__ball__' }, classes: 'ball', position: { x: 0, y: 0 } });
  cy.add({ data: { id: '__drum-ball__' }, classes: 'drum-ball', position: { x: 0, y: 0 } });
}

/** Unique node ID for one pitch occurrence at a specific step. */
const eventId = (note, step) => `${note}@${step}`;

function buildChordGroups() {
  const notes  = NOTES;
  const groups = new Map();
  for (let s = 0; s < STEPS; s++) {
    const notesAtStep = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      if (grid[r][s]) notesAtStep.push(notes[r]);
    }
    if (notesAtStep.length > 0) {
      const nodeIds  = notesAtStep.map(n => eventId(n, s));
      const anchorId = nodeIds[nodeIds.length - 1];
      groups.set(s, {
        notes: notesAtStep, nodeIds,
        anchor: notesAtStep[notesAtStep.length - 1], anchorId,
      });
    }
  }
  return groups;
}

function snapChordStacks() {
  chordGroups.forEach(({ nodeIds, anchorId }, step) => {
    if (nodeIds.length <= 1) return;
    const { x: ax, y: ay } = cy.getElementById(anchorId).position();
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    nodeIds.forEach((id, i) => {
      const stepsOut = nodeIds.length - 1 - i;
      cy.getElementById(id).position({
        x: ax + stepsOut * NODE_STACK_SPACING * dx,
        y: ay + stepsOut * NODE_STACK_SPACING * dy,
      });
    });
  });
}

function fitGraph() {
  if (!cy) return;
  cy.resize();
  positionAllRings();
}

/**
 * Planet formation: notes ring at canvas centre; each auto ring is a
 * separate satellite ring positioned at orbit distance around it.
 * Rings never overlap — orbit distance is computed from outer edges.
 */
function positionAllRings() {
  if (!cy) return;
  const containerW = cy.container().clientWidth  || 600;
  const containerH = cy.container().clientHeight || 400;
  const cx   = containerW / 2;
  const cy_c = containerH / 2;

  const autoParamList  = [...autoActive];
  const numAuto        = autoParamList.length;

  const NOTE_NODE     = 38;
  const AUTO_NODE_MAX = 42;  // max auto node diameter (min 28, max 42)
  const GAP           = 36;  // clear space between ring outer edges

  // Notes ring radius (independent of auto rings)
  const n = stepSequence.length;
  const containerMin  = Math.min(containerW, containerH);
  const noteMinR      = n > 1 ? (NOTE_NODE / 2 + 8) / Math.sin(Math.PI / n) : 0;
  const notesR        = Math.max(noteMinR, containerMin * 0.28, 50);

  // Notes ring stack outer edge
  let maxStackNodes = 1;
  chordGroups.forEach(({ nodeIds }) => {
    if (nodeIds.length > maxStackNodes) maxStackNodes = nodeIds.length;
  });
  const notesStackOuter = notesR + (maxStackNodes - 1) * NODE_STACK_SPACING + NOTE_NODE / 2;

  // Drum ring geometry
  const drumN        = drumStepSequence.length;
  const drumNodeSize = 30;
  const drumMinR     = drumN > 1 ? (drumNodeSize / 2 + 6) / Math.sin(Math.PI / drumN) : 0;
  const drumR        = drumN > 0 ? Math.max(drumMinR, containerMin * 0.22, 40) : 0;

  let maxDrumStackNodes = 1;
  drumChordGroups.forEach(({ nodeIds }) => { if (nodeIds.length > maxDrumStackNodes) maxDrumStackNodes = nodeIds.length; });
  const drumStackOuter = drumR + (maxDrumStackNodes - 1) * NODE_STACK_SPACING + drumNodeSize / 2;

  // Center notes + drum symmetrically around canvas center.
  // drumVertOffset = distance between the two ring centers.
  const MIN_RING_GAP = 28;
  const drumVertOffset = drumN > 0
    ? notesStackOuter + MIN_RING_GAP + drumStackOuter
    : 0;

  const notesCy = cy_c - drumVertOffset / 2;
  const drumCy  = cy_c + drumVertOffset / 2;

  // Position notes ring
  stepSequence.forEach(({ step, anchorId }) => {
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    cy.getElementById(anchorId).position({
      x: cx      + notesR * Math.cos(angle),
      y: notesCy + notesR * Math.sin(angle),
    });
  });
  snapChordStacks();

  // Position drum ring
  drumStepSequence.forEach(({ step, anchorId }) => {
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    cy.getElementById(anchorId).position({ x: cx + drumR * Math.cos(angle), y: drumCy + drumR * Math.sin(angle) });
  });
  snapDrumStacks();

  const drumsCenter = cy.getElementById('__drums-center__');
  if (drumsCenter.length) drumsCenter.position({ x: cx, y: drumCy });
  const notesCenter = cy.getElementById('__notes-center__');
  if (notesCenter.length) notesCenter.position({ x: cx, y: notesCy });

  // Combined cluster outer radius from canvas center.
  // Both rings are offset by drumVertOffset/2, so worst-case vertical reach is:
  // drumVertOffset/2 + max(notesStackOuter, drumStackOuter).
  const clusterR = drumVertOffset / 2 + Math.max(notesStackOuter, drumStackOuter);

  // Auto ring radius — minimum to fit 16 nodes at max size without overlap
  const AUTO_R = Math.max(88, (AUTO_NODE_MAX / 2 + 5) / Math.sin(Math.PI / 16));

  // Orbit must clear the combined cluster and leave room for siblings (full circle).
  const minFromCluster  = clusterR + GAP + AUTO_R + AUTO_NODE_MAX / 2;
  const minFromSiblings = numAuto > 1
    ? (AUTO_R + AUTO_NODE_MAX / 2 + GAP) / Math.sin(Math.PI / numAuto)
    : 0;
  const orbitDist = Math.max(minFromCluster, minFromSiblings);

  // Position auto rings evenly around the combined canvas center (full circle).
  autoParamList.forEach((paramId, i) => {
    const orbitAngle = (i / Math.max(numAuto, 1)) * 2 * Math.PI;
    const ringCx = cx   + orbitDist * Math.cos(orbitAngle);
    const ringCy = cy_c + orbitDist * Math.sin(orbitAngle);
    for (let s = 0; s < 16; s++) {
      const node = cy.getElementById(`auto-${paramId}-${s}`);
      if (!node.length) continue;
      const a = -Math.PI / 2 + (s / 16) * 2 * Math.PI;
      node.position({ x: ringCx + AUTO_R * Math.cos(a), y: ringCy + AUTO_R * Math.sin(a) });
    }
    const centerLabel = cy.getElementById(`__auto-center-${paramId}__`);
    if (centerLabel.length) centerLabel.position({ x: ringCx, y: ringCy });
  });

  cy.fit(40);
}

/** Legacy alias */
function positionNodes() { positionAllRings(); }

function updateGraph() {
  if (!cy) return;

  chordGroups = buildChordGroups();
  stepSequence = [];
  for (let s = 0; s < STEPS; s++) {
    if (chordGroups.has(s)) stepSequence.push({ step: s, ...chordGroups.get(s) });
  }

  const activeIds = new Set([...chordGroups.values()].flatMap(g => g.nodeIds));

  // Remove only notes-related edges (preserve auto-ring, drum-stack, drum-sequence edges)
  cy.edges().forEach(e => {
    const t = e.data('type');
    if (t !== 'auto-ring' && t !== 'drum-stack' && t !== 'drum-sequence') e.remove();
  });
  prevPlayingNodes = [];

  const ball = cy.getElementById('__ball__');
  if (ball.length) { ball.stop(); ball.style('opacity', 0); }

  // Remove only notes nodes (preserve auto, drum nodes and balls)
  cy.nodes().forEach(node => {
    const id = node.id();
    if (id === '__ball__' || id === '__drum-ball__') return;
    if (id.startsWith('auto-') || id.startsWith('__auto-')) return;
    if (id.startsWith('drum-') || id === '__drums-center__') return;
    if (activeIds.has(id)) {
      node.removeClass('playing');
    } else {
      node.remove();
    }
  });

  const containerW = cy.container().clientWidth  || 400;
  const containerH = cy.container().clientHeight || 380;
  const r = Math.min(containerW, containerH) * 0.35;
  chordGroups.forEach(({ notes, nodeIds }, step) => {
    notes.forEach((note, i) => {
      const id = nodeIds[i];
      if (cy.getElementById(id).length === 0) {
        const ni    = NOTES.indexOf(note);
        const angle = (step / STEPS) * 2 * Math.PI - Math.PI / 2;
        cy.add({
          data: { id, label: NOTE_LABELS[ni] },
          position: {
            x: containerW / 2 + r * Math.cos(angle),
            y: containerH / 2 + r * Math.sin(angle),
          },
        });
      }
    });
  });

  const stackEdges = [];
  chordGroups.forEach(({ nodeIds }, step) => {
    for (let i = 0; i < nodeIds.length - 1; i++) {
      stackEdges.push({
        data: { id: `stack-${step}-${i}`, source: nodeIds[i], target: nodeIds[i + 1], type: 'chord-stack' },
      });
    }
  });

  const seqEdges = [];
  if (stepSequence.length >= 2) {
    const n = stepSequence.length;
    stepSequence.forEach(({ step, anchorId }, i) => {
      const next = stepSequence[(i + 1) % n];
      let dist = i < n - 1 ? next.step - step : (STEPS - step) + next.step;
      dist = Math.max(dist, 1);
      seqEdges.push({
        data: { id: `seq-${i}`, source: anchorId, target: next.anchorId, dist, seqIdx: i, type: 'sequence' },
      });
    });
  }

  if (stackEdges.length || seqEdges.length) {
    cy.add([...stackEdges, ...seqEdges]);
  }

  // Manage Notes center label
  const notesCenter = cy.getElementById('__notes-center__');
  if (stepSequence.length === 0) {
    if (notesCenter.length) notesCenter.remove();
  } else if (!notesCenter.length) {
    cy.add({ data: { id: '__notes-center__', label: 'Notes' }, classes: 'notes-ring-label', position: { x: 0, y: 0 } });
  }

  positionAllRings();
  updateAutoBarNoteIndicators();
}

function updateGraphPlayhead(step, nextPos) {
  if (!cy) return;

  prevPlayingNodes.forEach(n => n.removeClass('playing'));
  prevPlayingNodes = [];

  if (!chordGroups.has(step)) return;

  chordGroups.get(step).nodeIds.forEach(id => {
    const node = cy.getElementById(id);
    if (node.length) { node.addClass('playing'); prevPlayingNodes.push(node); }
  });

  const ball = cy.getElementById('__ball__');
  if (!ball.length || stepSequence.length < 2) return;

  const srcGroup = chordGroups.get(step);
  if (!srcGroup) return;

  // Use nextPos (index into activeStepArray) so the search follows the actual play
  // direction in all modes (forward, reverse, ping-pong).
  const n = activeStepArray.length;
  let tgtGroup = null;
  let dist = 1;
  for (let i = 0; i < n; i++) {
    const gs = activeStepArray[(nextPos + i) % n];
    if (chordGroups.has(gs)) { tgtGroup = chordGroups.get(gs); dist = i + 1; break; }
  }
  if (!tgtGroup) return;

  const srcNode = cy.getElementById(srcGroup.anchorId);
  const tgtNode = cy.getElementById(tgtGroup.anchorId);
  if (!srcNode.length || !tgtNode.length) return;

  const stepMs   = (60 / Tone.Transport.bpm.value / 4) * 1000;
  const duration = Math.max(dist, 1) * stepMs;

  ball.stop();
  ball.position(srcNode.position());
  ball.style('opacity', 1);
  ball.animate({ position: tgtNode.position(), duration, easing: 'linear' });
}

// ═══════════════════════════════════════════════════════════
// D. AUTOMATION SEQUENCING
// ═══════════════════════════════════════════════════════════

function normalizeAutoValue(paramId, val) {
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  return (val - cfg.min) / (cfg.max - cfg.min);
}

function denormalizeAutoValue(paramId, norm) {
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  const val = cfg.min + norm * (cfg.max - cfg.min);
  return Math.max(cfg.min, Math.min(cfg.max, val));
}

function enterSeqMode(paramId) {
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  if (!cfg) return;

  // Lazy init: fill with current slider value if not yet created
  if (!autoSeqs[paramId]) {
    const slider = document.getElementById(paramId);
    const currentVal = slider ? parseFloat(slider.value) : cfg.default;
    autoSeqs[paramId] = new Float64Array(16).fill(currentVal);
  }

  autoActive.add(paramId);

  // Freeze slider
  const slider = document.getElementById(paramId);
  if (slider) slider.disabled = true;
  const group = slider && slider.closest('.adsr-group');
  if (group) {
    const lbl = group.querySelector('label');
    const val = group.querySelector('.adsr-val');
    if (lbl) lbl.classList.add('seq-frozen');
    if (val) val.classList.add('seq-frozen');
  }

  // Mark SEQ button active
  const btn = document.querySelector(`.seq-toggle-btn[data-param="${paramId}"]`);
  if (btn) {
    btn.classList.add('active');
    btn.style.setProperty('--param-color', cfg.color);
  }

  addTab(paramId, cfg);
  buildAutoSeqPanel(paramId);

  // Add per-param ball to main cy
  if (cy) {
    cy.add({
      data: { id: `__auto-ball-${paramId}__`, color: cfg.color },
      classes: 'auto-ball',
      position: { x: 0, y: 0 },
    });
  }

  rebuildAutoGraph(paramId); // adds nodes + calls positionAllRings()
  switchTab(paramId);
}

function exitSeqMode(paramId) {
  autoActive.delete(paramId);

  // Re-enable slider
  const slider = document.getElementById(paramId);
  if (slider) slider.disabled = false;
  const group = slider && slider.closest('.adsr-group');
  if (group) {
    const lbl = group.querySelector('label');
    const val = group.querySelector('.adsr-val');
    if (lbl) lbl.classList.remove('seq-frozen');
    if (val) val.classList.remove('seq-frozen');
  }

  // Deactivate SEQ button
  const btn = document.querySelector(`.seq-toggle-btn[data-param="${paramId}"]`);
  if (btn) btn.classList.remove('active');

  removeTab(paramId);
  const panel = document.getElementById(`auto-seq-${paramId}`);
  if (panel) panel.remove();

  // Remove auto nodes, edges, and ball from main cy
  if (cy) {
    for (let s = 0; s < 16; s++) cy.getElementById(`auto-${paramId}-${s}`).remove();
    cy.edges().forEach(e => { if (e.id().startsWith(`auto-edge-${paramId}-`)) e.remove(); });
    cy.getElementById(`__auto-ball-${paramId}__`).remove();
    cy.getElementById(`__auto-center-${paramId}__`).remove();
  }
  delete prevAutoPlayingNode[paramId];
  positionAllRings();

  if (autoActive.size === 0) {
    switchTab('notes');
  } else if (activeTab === paramId) {
    switchTab([...autoActive][0]);
  }
}

function addTab(paramId, cfg) {
  const tabs = document.getElementById('seq-tabs');
  if (tabs.querySelector(`.seq-tab[data-tab="${paramId}"]`)) return;
  const btn = document.createElement('button');
  btn.className = 'seq-tab';
  btn.dataset.tab = paramId;
  btn.style.setProperty('--tab-color', cfg.color);
  btn.textContent = cfg.label;
  btn.addEventListener('click', () => switchTab(paramId));
  tabs.appendChild(btn);
}

function removeTab(paramId) {
  const btn = document.querySelector(`.seq-tab[data-tab="${paramId}"]`);
  if (btn) btn.remove();
}

function switchTab(tabId) {
  activeTab = tabId;

  // Update tab active states
  document.querySelectorAll('.seq-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  const pianoRoll = document.getElementById('piano-roll');
  const autoPanel = document.getElementById('auto-seq-panel');

  if (tabId === 'notes') {
    pianoRoll.style.display = '';
    autoPanel.style.display = 'none';
  } else {
    pianoRoll.style.display = 'none';
    autoPanel.style.display = 'flex';
    // Show only the active param panel
    autoPanel.querySelectorAll('.auto-seq-param-panel').forEach(p => {
      p.style.display = p.id === `auto-seq-${tabId}` ? 'flex' : 'none';
    });
  }
}

function buildAutoSeqPanel(paramId) {
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  const container = document.getElementById('auto-seq-panel');

  const panel = document.createElement('div');
  panel.id = `auto-seq-${paramId}`;
  panel.className = 'auto-seq-param-panel';

  const seq = autoSeqs[paramId];

  for (let s = 0; s < 16; s++) {
    const wrap = document.createElement('div');
    wrap.className = 'auto-bar-wrap';

    const num = document.createElement('div');
    num.className = 'auto-bar-step-num';
    num.textContent = s + 1;

    const track = document.createElement('div');
    track.className = 'auto-bar-track';
    track.dataset.step = s;
    track.style.setProperty('--bar-color', cfg.color);

    const fill = document.createElement('div');
    fill.className = 'auto-bar-fill';
    fill.style.setProperty('--bar-color', cfg.color);
    const norm = normalizeAutoValue(paramId, seq[s]);
    fill.style.height = (norm * 100) + '%';

    track.appendChild(fill);

    const noteDot = document.createElement('div');
    noteDot.className = 'auto-note-dot';

    wrap.appendChild(track);
    wrap.appendChild(noteDot);
    wrap.appendChild(num);
    panel.appendChild(wrap);
  }

  container.appendChild(panel);
  attachAutoBarEvents(paramId, panel);
  updateAutoBarNoteIndicators();
}

function attachAutoBarEvents(paramId, panel) {
  let dragging = false;

  panel.querySelectorAll('.auto-bar-track').forEach(track => {
    track.addEventListener('mousedown', e => {
      dragging = true;
      const step = parseInt(track.dataset.step, 10);
      setAutoBarValue(e, paramId, step, track);
      e.preventDefault();
    });
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Find track under cursor within this panel
    const tracks = panel.querySelectorAll('.auto-bar-track');
    for (const track of tracks) {
      const rect = track.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right) {
        const step = parseInt(track.dataset.step, 10);
        setAutoBarValue(e, paramId, step, track);
        break;
      }
    }
  });

  window.addEventListener('mouseup', () => { dragging = false; });
}

function setAutoBarValue(e, paramId, step, track) {
  const rect = track.getBoundingClientRect();
  const norm = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
  autoSeqs[paramId][step] = denormalizeAutoValue(paramId, norm);

  const fill = track.querySelector('.auto-bar-fill');
  if (fill) fill.style.height = (norm * 100) + '%';

  updateAutoGraphNode(paramId, step); // always update — graph always shows all rings
}

function rebuildAutoGraph(paramId) {
  if (!cy) return;
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  if (!cfg) return;

  // Remove existing nodes/edges/label for this param (re-add fresh)
  for (let s = 0; s < 16; s++) cy.getElementById(`auto-${paramId}-${s}`).remove();
  cy.edges().forEach(e => { if (e.id().startsWith(`auto-edge-${paramId}-`)) e.remove(); });
  cy.getElementById(`__auto-center-${paramId}__`).remove();

  const seq = autoSeqs[paramId];
  if (!seq) return;

  const edgeColor = hexToRgba(cfg.color, 0.3);

  // Add 16 ring nodes (positioned at origin; positionAllRings will fix)
  for (let s = 0; s < 16; s++) {
    const val  = seq[s];
    const norm = normalizeAutoValue(paramId, val);
    cy.add({
      data: {
        id: `auto-${paramId}-${s}`,
        label: cfg.format(val),
        color: cfg.color,
        bgColor: blendWithDark(cfg.color, 0.12),
        size: 28 + norm * 14,
      },
      classes: 'auto-node',
      position: { x: 0, y: 0 },
    });
  }

  // Add 16 ring edges
  for (let s = 0; s < 16; s++) {
    cy.add({
      data: {
        id: `auto-edge-${paramId}-${s}`,
        source: `auto-${paramId}-${s}`,
        target: `auto-${paramId}-${(s + 1) % 16}`,
        type: 'auto-ring',
        edgeColor,
      },
    });
  }

  // Add center label node (positioned by positionAllRings)
  cy.add({
    data: {
      id: `__auto-center-${paramId}__`,
      label: cfg.label,
      dimColor: hexToRgba(cfg.color, 0.45),
    },
    classes: 'auto-ring-label',
    position: { x: 0, y: 0 },
  });

  prevAutoPlayingNode[paramId] = null;
  positionAllRings();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Simple hex color blend with dark background #08080f */
function blendWithDark(hexColor, alpha) {
  try {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const br = 8, bg = 8, bb = 15; // #08080f
    const rr = Math.round(r * alpha + br * (1 - alpha));
    const rg = Math.round(g * alpha + bg * (1 - alpha));
    const rb = Math.round(b * alpha + bb * (1 - alpha));
    return `#${rr.toString(16).padStart(2,'0')}${rg.toString(16).padStart(2,'0')}${rb.toString(16).padStart(2,'0')}`;
  } catch (_) { return '#08080f'; }
}

function updateAutoGraphNode(paramId, step) {
  if (!cy) return;
  const cfg = AUTO_PARAMS.find(p => p.id === paramId);
  if (!cfg) return;
  const node = cy.getElementById(`auto-${paramId}-${step}`);
  if (!node.length) return;
  const val  = autoSeqs[paramId][step];
  const norm = normalizeAutoValue(paramId, val);
  node.data('label', cfg.format(val));
  node.data('size', 28 + norm * 14);
}

function updateAutoGraphPlayhead(paramId, step, nextStep) {
  if (!cy) return;

  // Un-highlight previous node for this param
  if (prevAutoPlayingNode[paramId]) {
    prevAutoPlayingNode[paramId].removeClass('auto-playing');
    prevAutoPlayingNode[paramId] = null;
  }

  const curNode = cy.getElementById(`auto-${paramId}-${step}`);
  if (curNode.length) {
    curNode.addClass('auto-playing');
    prevAutoPlayingNode[paramId] = curNode;
  }

  // Animate per-param ball
  const ball    = cy.getElementById(`__auto-ball-${paramId}__`);
  if (!ball.length) return;
  const srcNode = cy.getElementById(`auto-${paramId}-${step}`);
  const tgtNode = cy.getElementById(`auto-${paramId}-${nextStep}`);
  if (!srcNode.length || !tgtNode.length) return;

  const stepMs = (60 / Tone.Transport.bpm.value / 4) * 1000;
  ball.stop();
  ball.position(srcNode.position());
  ball.style('opacity', 1);
  ball.animate({ position: tgtNode.position(), duration: stepMs, easing: 'linear' });
}

/** Show a teal dot on every auto bar column that has an active note. */
function updateAutoBarNoteIndicators() {
  document.querySelectorAll('.auto-bar-wrap').forEach(wrap => {
    const track = wrap.querySelector('.auto-bar-track');
    if (!track) return;
    const step = parseInt(track.dataset.step, 10);
    let hasNote = false;
    for (let r = 0; r < NUM_ROWS; r++) {
      if (grid[r][step]) { hasNote = true; break; }
    }
    wrap.classList.toggle('has-note', hasNote);
  });
}

function highlightAutoBarPlayhead(step) {
  if (activeTab === 'notes') return;
  const panel = document.getElementById(`auto-seq-${activeTab}`);
  if (!panel) return;
  panel.querySelectorAll('.auto-bar-track').forEach(el => el.classList.remove('playhead'));
  const track = panel.querySelector(`.auto-bar-track[data-step="${step}"]`);
  if (track) track.classList.add('playhead');
}

function initAutoParams() {
  // Wire SEQ toggle buttons
  document.querySelectorAll('.seq-toggle-btn').forEach(btn => {
    const paramId = btn.dataset.param;
    btn.addEventListener('click', () => {
      if (autoActive.has(paramId)) exitSeqMode(paramId);
      else enterSeqMode(paramId);
    });
  });

  // Wire Notes tab
  const notesTab = document.querySelector('.seq-tab[data-tab="notes"]');
  if (notesTab) notesTab.addEventListener('click', () => switchTab('notes'));
}

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  buildPianoRoll();
  initSynth();
  initGraph();
  initAutoParams();
  initDrumSection();
  initMetronome();

  // Warm up AudioContext on first interaction so it's ready before Play is pressed
  document.addEventListener('pointerdown', async () => { await Tone.start(); }, { once: true });

  // Drag-to-paint: track pointer across step/drum cells and paint them all
  document.addEventListener('pointermove', (e) => {
    if (!cellDragState) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    if (cellDragState.type === 'notes' && el.classList.contains('step-cell')) {
      const r = parseInt(el.dataset.row), s = parseInt(el.dataset.step);
      if (!isNaN(r) && !isNaN(s)) applyCell('notes', r, s, el, cellDragState.activating);
    } else if (cellDragState.type === 'drums' && el.classList.contains('drum-cell')) {
      const r = parseInt(el.dataset.row), s = parseInt(el.dataset.step);
      if (!isNaN(r) && !isNaN(s)) applyCell('drums', r, s, el, cellDragState.activating);
    }
  });
  // Rebuild graph once when the drag ends (avoids repeated rebuilds mid-drag)
  document.addEventListener('pointerup', () => {
    if (!cellDragState) return;
    if (cellDragState.type === 'notes') updateGraph();
    else updateDrumGraph();
    cellDragState = null;
  });

  document.getElementById('play-btn').addEventListener('click', play);
  document.getElementById('metro-btn').addEventListener('click', toggleMetronome);
  document.getElementById('stop-btn').addEventListener('click', stop);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('seq-clear-btn').addEventListener('click', clearCurrentSeq);
  document.getElementById('notes-mute-btn').addEventListener('click', () => {
    notesMuted = !notesMuted;
    document.getElementById('notes-mute-btn').classList.toggle('active', notesMuted);
  });
  document.getElementById('drum-seq-mute-btn').addEventListener('click', () => {
    drumSeqMuted = !drumSeqMuted;
    document.getElementById('drum-seq-mute-btn').classList.toggle('active', drumSeqMuted);
  });
  document.getElementById('random-btn').addEventListener('click', () => {
    if (activeTab === 'notes') randomSeq();
    else randomizeAutoSeq(activeTab);
  });
  document.getElementById('fit-btn').addEventListener('click', fitGraph);

  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel  = document.getElementById('settings-panel');
  settingsToggle.addEventListener('click', () => {
    const collapsed = settingsPanel.classList.toggle('collapsed');
    settingsToggle.textContent = collapsed ? '\u2699 Controls \u25b6' : '\u2699 Controls \u25bc';
    settingsToggle.classList.toggle('open', !collapsed);
  });
  settingsToggle.classList.add('open');

  function makeCollapseToggle(btnId, targetId, afterShow) {
    const btn   = document.getElementById(btnId);
    const panel = document.getElementById(targetId);
    btn.addEventListener('click', () => {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? '' : 'none';
      btn.classList.toggle('collapsed', !isHidden);
      if (isHidden && afterShow) afterShow();
    });
  }

  makeCollapseToggle('seq-toggle',   'seq-body');
  makeCollapseToggle('drum-toggle',  'drum-body');
  makeCollapseToggle('graph-toggle', 'graph-wrap', fitGraph);

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitGraph, 80);
  }).observe(document.getElementById('graph-wrap'));

  document.getElementById('bpm').addEventListener('input', e => setBPM(e.target.value));

  document.querySelectorAll('.waveform-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.waveform-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setWaveform(btn.dataset.wave);
    });
  });

  document.querySelectorAll('.playmode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.playmode-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setPlaybackMode(btn.dataset.mode);
    });
  });

  // Volume
  document.getElementById('vol').addEventListener('input', e => {
    const db = parseInt(e.target.value, 10);
    setMasterVolume(db);
    document.getElementById('vol-val').textContent = `${db}dB`;
  });

  // Filter controls
  document.getElementById('flt-freq').addEventListener('input', e => {
    const freq = freqFromSlider(parseFloat(e.target.value));
    filter.frequency.value = freq;
    document.getElementById('flt-freq-val').textContent = formatFreq(freq);
  });

  document.getElementById('flt-q').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    filter.Q.value = val;
    document.getElementById('flt-q-val').textContent = val.toFixed(1);
  });

  document.querySelectorAll('.filter-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-type-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      filter.type = btn.dataset.type;
    });
  });

  // Reverb controls
  document.getElementById('rvb-send').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    reverbSend.gain.value = val;
    document.getElementById('rvb-send-val').textContent = val.toFixed(2);
  });

  let reverbDecayTimer = null;
  document.getElementById('rvb-decay').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    document.getElementById('rvb-decay-val').textContent = val.toFixed(1) + 's';
    reverb.decay = val;
    clearTimeout(reverbDecayTimer);
    reverbDecayTimer = setTimeout(() => reverb.generate(), 400);
  });

  // ADSR sliders
  const adsrParams = [
    { id: 'adsr-a', param: 'attack',  valId: 'adsr-a-val', unit: 's' },
    { id: 'adsr-d', param: 'decay',   valId: 'adsr-d-val', unit: 's' },
    { id: 'adsr-s', param: 'sustain', valId: 'adsr-s-val', unit: ''  },
    { id: 'adsr-r', param: 'release', valId: 'adsr-r-val', unit: 's' },
  ];
  adsrParams.forEach(({ id, param, valId, unit }) => {
    const slider  = document.getElementById(id);
    const display = document.getElementById(valId);
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      setEnvelope(param, val);
      display.textContent = val.toFixed(2) + unit;
    });
  });

  // Octave controls
  document.getElementById('oct-down').addEventListener('click', () => setOctave(-1));
  document.getElementById('oct-up').addEventListener('click',   () => setOctave(+1));

  // Root note
  document.querySelectorAll('.root-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.root-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setRootNote(parseInt(btn.dataset.semitone, 10));
    });
  });
});
