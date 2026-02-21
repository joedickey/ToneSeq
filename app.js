'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NUM_ROWS  = 13;   // one octave inclusive (e.g. C4 → C5)
const STEPS     = 16;
const NODE_STACK_SPACING = 52; // px between node centres in a chord stack

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
// STATE
// ═══════════════════════════════════════════════════════════

// grid[row][step] = true/false  (row 0 = highest note, row 12 = lowest)
const grid = {};
for (let r = 0; r < NUM_ROWS; r++) { grid[r] = new Array(STEPS).fill(false); }

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

let prevPlayingNodes = [];

let playbackMode        = 'forward';  // 'forward' | 'reverse' | 'pingpong'
let pendingPlaybackMode = null;
let activeStepArray     = [];
let seqPosition         = 0;

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
      cell.addEventListener('click', () => onCellClick(r, s, cell));
      container.appendChild(cell);
    }
  }
}

function onCellClick(row, step, cell) {
  grid[row][step] = !grid[row][step];
  cell.classList.toggle('active', grid[row][step]);
  updateGraph();
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

  loop = Tone.Transport.scheduleRepeat((time) => {
    // At the start of each new pass, apply any queued mode change
    if (seqPosition === 0 && pendingPlaybackMode !== null) {
      playbackMode = pendingPlaybackMode;
      pendingPlaybackMode = null;
      activeStepArray = getStepArray(playbackMode);
    }

    const step = activeStepArray[seqPosition];
    const nextPos = (seqPosition + 1) % activeStepArray.length;
    const nextGridStep = activeStepArray[nextPos];
    seqPosition = nextPos;

    // Collect active notes for this step using current NOTES mapping
    const activeNotes = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      if (grid[r][step]) activeNotes.push(NOTES[r]);
    }
    if (activeNotes.length > 0) {
      // Equal-power polyphony compensation: 1/√n velocity per voice
      const velocity = 1 / Math.sqrt(activeNotes.length);
      synth.triggerAttackRelease(activeNotes, '16n', time, velocity);
    }
    scheduleVisual(() => {
      highlightPlayhead(step);
      updateGraphPlayhead(step, nextGridStep);
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

  buildLoop();
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
  Tone.Transport.start();
  isPlaying = true;
}

function stop() {
  if (!isPlaying) return;
  Tone.Transport.stop();
  isPlaying = false;
  seqPosition = 0;
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
}

function setBPM(val) {
  const bpm = parseInt(val, 10);
  if (!isNaN(bpm) && bpm > 0) Tone.Transport.bpm.value = bpm;
}

function setWaveform(type) { synth.set({ oscillator: { type } }); }

function setEnvelope(param, value) { synth.set({ envelope: { [param]: value } }); }

function setMasterVolume(db) {
  if (masterVol) masterVol.volume.rampTo(db, 0.05);
}

function clearAll() {
  for (let r = 0; r < NUM_ROWS; r++) grid[r].fill(false);
  document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));
  updateGraph();
}

// ─── Random Sequence ───────────────────────────────────────

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Fill the grid with a randomised sequence:
 *   - 6–12 steps active (never all 16, always at least 6)
 *   - 1–4 notes per step, weighted toward sparser chords
 *   - Notes chosen without replacement within each step
 */
function randomSeq() {
  for (let r = 0; r < NUM_ROWS; r++) grid[r].fill(false);
  document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));

  const numSteps   = 6 + Math.floor(Math.random() * 7);   // 6–12
  const activeSteps = shuffleArray([...Array(STEPS).keys()]).slice(0, numSteps);

  activeSteps.forEach(step => {
    // Note-count distribution: 1→45 %, 2→30 %, 3→18 %, 4→7 %
    const r = Math.random();
    const noteCount = r < 0.45 ? 1 : r < 0.75 ? 2 : r < 0.93 ? 3 : 4;
    const rows = shuffleArray([...Array(NUM_ROWS).keys()]).slice(0, noteCount);
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
    ],
    elements: [],
    layout: { name: 'null' },
  });

  cy.add({ data: { id: '__ball__' }, classes: 'ball', position: { x: 0, y: 0 } });
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
  positionNodes();
}

function positionNodes() {
  const containerW = cy.container().clientWidth  || 400;
  const containerH = cy.container().clientHeight || 380;
  const containerMin = Math.min(containerW, containerH);

  const n     = stepSequence.length;
  const baseR = containerMin * 0.28;
  const minR  = n > 1 ? (38 + 8) / (2 * Math.sin(Math.PI / n)) : 0;
  const r     = Math.max(baseR, minR);
  const cx    = containerW / 2;
  const cy_center = containerH / 2;

  stepSequence.forEach(({ step, anchorId }) => {
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    cy.getElementById(anchorId).position({
      x: cx        + r * Math.cos(angle),
      y: cy_center + r * Math.sin(angle),
    });
  });

  snapChordStacks();
  cy.fit(40);
}

function updateGraph() {
  if (!cy) return;

  chordGroups = buildChordGroups();
  stepSequence = [];
  for (let s = 0; s < STEPS; s++) {
    if (chordGroups.has(s)) stepSequence.push({ step: s, ...chordGroups.get(s) });
  }

  const activeIds = new Set([...chordGroups.values()].flatMap(g => g.nodeIds));

  cy.edges().remove();
  prevPlayingNodes = [];

  const ball = cy.getElementById('__ball__');
  if (ball.length) { ball.stop(); ball.style('opacity', 0); }

  cy.nodes().forEach(node => {
    if (node.id() === '__ball__') return;
    if (activeIds.has(node.id())) {
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

  if (activeIds.size === 0) return;

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

  cy.add([...stackEdges, ...seqEdges]);
  positionNodes();
}

function updateGraphPlayhead(step, nextGridStep) {
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

  const n = activeStepArray.length;
  const seqPos = activeStepArray.indexOf(nextGridStep);
  let tgtGroup = null;
  let dist = 1;
  for (let i = 0; i < n; i++) {
    const gs = activeStepArray[(seqPos + i) % n];
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
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  buildPianoRoll();
  initSynth();
  initGraph();

  document.getElementById('play-btn').addEventListener('click', play);
  document.getElementById('stop-btn').addEventListener('click', stop);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('random-btn').addEventListener('click', randomSeq);
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

  makeCollapseToggle('seq-toggle',   'piano-roll');
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
