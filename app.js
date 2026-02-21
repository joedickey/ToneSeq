'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

// C5 at top, C4 at bottom (13 semitones inclusive)
const NOTES = ['C5','B4','A#4','A4','G#4','G4','F#4','F4','E4','D#4','D4','C#4','C4'];
const NOTE_LABELS = ['C5','B','A#','A','G#','G','F#','F','E','D#','D','C#','C4'];
const STEPS = 16;
const PX_PER_STEP = 22; // pixels per rhythmic step for COSE ideal edge length

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

// grid[note][step] = true/false
const grid = {};
NOTES.forEach(note => { grid[note] = new Array(STEPS).fill(false); });

let currentSequence = []; // ordered (note, step) event list; rebuilt on every toggle
let synth = null;
let loop = null;
let cy = null;
let isPlaying = false;

// Tracks which Cytoscape elements have the 'playing' class so we can clear them
let prevPlayingNodes = [];
let prevPlayingEdges = [];

// ═══════════════════════════════════════════════════════════
// A. PIANO ROLL
// ═══════════════════════════════════════════════════════════

function buildPianoRoll() {
  const container = document.getElementById('piano-roll');

  // Header row: blank label + step numbers 1–16
  const blankLabel = document.createElement('div');
  blankLabel.className = 'pr-label';
  container.appendChild(blankLabel);

  for (let s = 0; s < STEPS; s++) {
    const num = document.createElement('div');
    num.className = 'pr-step-num';
    num.textContent = s + 1;
    container.appendChild(num);
  }

  // Note rows — C5 at top, C4 at bottom
  NOTES.forEach((note, ni) => {
    const lbl = document.createElement('div');
    lbl.className = 'pr-label';
    lbl.textContent = NOTE_LABELS[ni];
    container.appendChild(lbl);

    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('div');
      cell.className = 'step-cell';
      cell.dataset.note = note;
      cell.dataset.step = s;
      cell.addEventListener('click', () => onCellClick(note, s, cell));
      container.appendChild(cell);
    }
  });
}

function onCellClick(note, step, cell) {
  grid[note][step] = !grid[note][step];
  cell.classList.toggle('active', grid[note][step]);
  updateGraph();
}

function highlightPlayhead(step) {
  document.querySelectorAll('.step-cell.playhead').forEach(el => el.classList.remove('playhead'));
  document.querySelectorAll(`.step-cell[data-step="${step}"]`).forEach(el => el.classList.add('playhead'));
}

// ═══════════════════════════════════════════════════════════
// B. SEQUENCER (Tone.js)
// ═══════════════════════════════════════════════════════════

function initSynth() {
  synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.4 },
  });
  synth.toDestination();

  loop = new Tone.Sequence(
    (time, step) => {
      // Trigger audio
      const activeNotes = NOTES.filter(n => grid[n][step]);
      if (activeNotes.length > 0) {
        synth.triggerAttackRelease(activeNotes, '16n', time);
      }
      // Schedule visual update in sync with the audio clock
      scheduleVisual(() => {
        highlightPlayhead(step);
        updateGraphPlayhead(step);
      }, time);
    },
    [...Array(STEPS).keys()],
    '16n',
  );
  // Schedule loop to always start at transport position 0
  loop.start(0);
}

/**
 * Run a visual callback in sync with Tone.js audio time.
 * Uses Tone.getDraw() when available, falls back to rAF.
 */
function scheduleVisual(cb, time) {
  if (typeof Tone.getDraw === 'function') {
    try {
      Tone.getDraw().schedule(cb, time);
      return;
    } catch (_) { /* fall through */ }
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

  // Clear piano roll playhead
  document.querySelectorAll('.step-cell.playhead').forEach(el => el.classList.remove('playhead'));

  // Clear graph playing state
  prevPlayingNodes.forEach(n => n.removeClass('playing'));
  prevPlayingEdges.forEach(e => e.removeClass('playing'));
  prevPlayingNodes = [];
  prevPlayingEdges = [];
}

function setBPM(val) {
  const bpm = parseInt(val, 10);
  if (!isNaN(bpm) && bpm > 0) Tone.Transport.bpm.value = bpm;
}

function setWaveform(type) {
  synth.set({ oscillator: { type } });
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
          'width': 38,
          'height': 38,
          'background-color': '#1a1a30',
          'border-width': 1,
          'border-color': '#2e2e50',
          'label': 'data(label)',
          'font-size': '11px',
          'font-family': 'monospace',
          'color': '#445',
          'text-valign': 'center',
          'text-halign': 'center',
        },
      },
      {
        selector: 'node.active-note',
        style: {
          'background-color': '#00251e',
          'border-color': '#00d4aa',
          'border-width': 2,
          'color': '#00d4aa',
        },
      },
      {
        selector: 'node.playing',
        style: {
          'background-color': '#2e2500',
          'border-color': '#ffcc00',
          'border-width': 2.5,
          'color': '#ffcc00',
        },
      },
      {
        selector: 'edge',
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
        selector: 'edge.playing',
        style: {
          'line-color': '#ffcc00',
          'target-arrow-color': '#ffcc00',
          'width': 2.5,
        },
      },
    ],
    elements: {
      nodes: NOTES.map((note, i) => ({
        data: { id: note, label: NOTE_LABELS[i] },
      })),
    },
    layout: { name: 'circle', padding: 40 },
  });
}

/**
 * Build an ordered flat list of (note, step) events by walking steps 0–15
 * left-to-right and notes top-to-bottom within each step.
 */
function buildSequence() {
  const seq = [];
  for (let s = 0; s < STEPS; s++) {
    NOTES.forEach(note => {
      if (grid[note][s]) seq.push({ note, step: s });
    });
  }
  return seq;
}

/**
 * Rebuild node/edge state and re-run the COSE layout whenever the grid changes.
 */
function updateGraph() {
  if (!cy) return;

  currentSequence = buildSequence();
  const activeSet = new Set(currentSequence.map(e => e.note));

  // Sync node highlight classes
  cy.nodes().forEach(node => {
    node.toggleClass('active-note', activeSet.has(node.id()));
    node.removeClass('playing');
  });

  // Remove all previous edges
  cy.edges().remove();
  prevPlayingEdges = [];
  prevPlayingNodes = [];

  if (currentSequence.length < 2) return;

  const n = currentSequence.length;

  // Build directed edges: consecutive events + cyclic wrap
  const edgeDefs = currentSequence.map((curr, i) => {
    const next = currentSequence[(i + 1) % n];

    let dist;
    if (i < n - 1) {
      // Forward distance within the bar
      dist = next.step - curr.step;
    } else {
      // Cyclic wrap: distance from last event back to first
      dist = (STEPS - curr.step) + next.step;
    }
    dist = Math.max(dist, 1); // minimum 1 to avoid zero-length edges

    return {
      data: {
        id: `e${i}`,
        source: curr.note,
        target: next.note,
        dist,
        seqIdx: i,
      },
    };
  });

  cy.add(edgeDefs);

  // COSE force-directed layout: ideal edge length encodes step distance
  cy.layout({
    name: 'cose',
    idealEdgeLength: edge => edge.data('dist') * PX_PER_STEP,
    animate: false,
    fit: true,
    padding: 40,
    randomize: false,
    nodeRepulsion: () => 250000,
    nodeOverlap: 20,
    edgeElasticity: () => 100,
    gravity: 60,
    numIter: 1000,
    initialTemp: 150,
    coolingFactor: 0.95,
    minTemp: 1.0,
  }).run();
}

/**
 * Called on every sequencer tick (via scheduleVisual).
 * Highlights the node(s) and incoming edge(s) for the current step.
 */
function updateGraphPlayhead(step) {
  if (!cy) return;

  // Clear previous playing highlights
  prevPlayingNodes.forEach(n => n.removeClass('playing'));
  prevPlayingEdges.forEach(e => e.removeClass('playing'));
  prevPlayingNodes = [];
  prevPlayingEdges = [];

  const n = currentSequence.length;
  if (n === 0) return;

  currentSequence.forEach((event, idx) => {
    if (event.step !== step) return;

    // Highlight the node for this note
    const node = cy.getElementById(event.note);
    if (node.length) {
      node.addClass('playing');
      prevPlayingNodes.push(node);
    }

    // Highlight the edge that leads INTO this event (just traversed)
    if (n >= 2) {
      const incomingSeqIdx = (idx - 1 + n) % n;
      cy.edges(`[seqIdx = ${incomingSeqIdx}]`).forEach(e => {
        e.addClass('playing');
        prevPlayingEdges.push(e);
      });
    }
  });
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

  document.getElementById('bpm').addEventListener('input', e => setBPM(e.target.value));

  document.querySelectorAll('.waveform-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.waveform-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setWaveform(btn.dataset.wave);
    });
  });
});
