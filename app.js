'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

// C5 at top, C4 at bottom (13 semitones inclusive)
const NOTES = ['C5','B4','A#4','A4','G#4','G4','F#4','F4','E4','D#4','D4','C#4','C4'];
const NOTE_LABELS = ['C5','B','A#','A','G#','G','F#','F','E','D#','D','C#','C4'];
const STEPS = 16;
const PX_PER_STEP = 22;
const NODE_STACK_SPACING = 52; // px between node centres in a chord stack

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

// grid[note][step] = true/false
const grid = {};
NOTES.forEach(note => { grid[note] = new Array(STEPS).fill(false); });

// chordGroups: Map<step, { notes: string[] (high→low), anchor: string (lowest pitch) }>
let chordGroups = new Map();

// stepSequence: [{ step, notes, anchor }, ...] in step order — drives sequence edges
let stepSequence = [];

let synth      = null;
let filter     = null;
let reverbSend = null;
let reverb     = null;
let loop = null;
let cy = null;
let isPlaying = false;

let prevPlayingNodes = [];

let playbackMode        = 'forward';  // 'forward' | 'reverse' | 'pingpong'
let pendingPlaybackMode = null;       // applied at next loop boundary
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

/** Logarithmic slider (0–100) → frequency in Hz (20 Hz – 20 kHz). */
function freqFromSlider(v) { return Math.round(20 * Math.pow(1000, v / 100)); }
function formatFreq(hz)    { return hz >= 1000 ? (hz / 1000).toFixed(1) + 'kHz' : hz + 'Hz'; }

/** Build the ordered step array for the current playback mode. */
function getStepArray(mode) {
  const fwd = [...Array(STEPS).keys()];             // [0..15]
  if (mode === 'reverse')  return [...fwd].reverse();              // [15..0]
  if (mode === 'pingpong') return [...fwd, ...[...fwd].reverse()]; // [0..15,15..0]
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

    const activeNotes = NOTES.filter(n => grid[n][step]);
    if (activeNotes.length > 0) {
      // Equal-power polyphony compensation: 1/√n velocity per voice so
      // combined amplitude stays constant regardless of chord size.
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

  // Signal chain: synth → filter → softLimit → destination (dry)
  //                            → reverbSend → reverb → softLimit (wet)
  //
  // softLimit is a high-ratio soft-knee compressor. It tames resonance peaks
  // and polyphony buildups by reacting to actual signal level rather than slider
  // position, so the filter sweeps and resonance feel completely natural.
  filter    = new Tone.Filter({ frequency: freqFromSlider(75), type: 'lowpass', Q: 1 });
  reverbSend = new Tone.Gain(0);
  reverb     = new Tone.Reverb({ decay: 2, wet: 1 }); // IR auto-generated on construction
  const softLimit = new Tone.Compressor({ threshold: -6, ratio: 20, attack: 0.001, release: 0.1, knee: 10 });

  synth.connect(filter);
  filter.connect(softLimit);
  filter.connect(reverbSend);
  reverbSend.connect(reverb);
  reverb.connect(softLimit);
  softLimit.toDestination();

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
  // Flush any pending mode change so next play starts in the selected mode
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

function clearAll() {
  NOTES.forEach(note => { for (let s = 0; s < STEPS; s++) grid[note][s] = false; });
  document.querySelectorAll('.step-cell.active').forEach(el => el.classList.remove('active'));
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
          'width': 38,
          'height': 38,
          'background-color': '#00251e',
          'border-width': 2,
          'border-color': '#00d4aa',
          'label': 'data(label)',
          'font-size': '11px',
          'font-family': 'monospace',
          'color': '#00d4aa',
          'text-valign': 'center',
          'text-halign': 'center',
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
      // Rhythmic sequence arrows
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
      // Traversal ball — animated node that rides sequence edges
      {
        selector: 'node.ball',
        style: {
          'width': 14,
          'height': 14,
          'background-color': '#ffcc00',
          'border-width': 2,
          'border-color': '#ffaa00',
          'label': '',
          'opacity': 0,
          'z-index': 999,
        },
      },
      // Chord-stack pipes — thin, no arrows, straight
      {
        selector: 'edge[type = "chord-stack"]',
        style: {
          'width': 2,
          'line-color': '#1a4040',
          'target-arrow-shape': 'none',
          'source-arrow-shape': 'none',
          'curve-style': 'straight',
        },
      },
    ],
    elements: [],
    layout: { name: 'null' },
  });

  // Add the traversal ball (hidden until playback starts)
  cy.add({ data: { id: '__ball__' }, classes: 'ball', position: { x: 0, y: 0 } });
}

/** Unique node ID for one occurrence of a note at a specific step. */
const eventId = (note, step) => `${note}@${step}`;

/**
 * Group active notes by step.
 * Notes within a step are ordered high→low (NOTES array order).
 * Each note occurrence gets its own event-node ID so the same pitch at two
 * different steps produces two distinct nodes — no self-loops possible.
 * The anchor = lowest pitch = bottom of the snowman stack.
 */
function buildChordGroups() {
  const groups = new Map();
  for (let s = 0; s < STEPS; s++) {
    const notesAtStep = NOTES.filter(n => grid[n][s]); // already high→low
    if (notesAtStep.length > 0) {
      const nodeIds  = notesAtStep.map(n => eventId(n, s));
      const anchorId = nodeIds[nodeIds.length - 1]; // lowest pitch node
      groups.set(s, {
        notes: notesAtStep,
        nodeIds,
        anchor:   notesAtStep[notesAtStep.length - 1],
        anchorId,
      });
    }
  }
  return groups;
}

/**
 * Snap every chord stack outward from the circle center along the step's
 * radial direction, so stacks never collide with nodes on the opposite side.
 * Called after anchor positions are set by positionNodes().
 */
function snapChordStacks() {
  chordGroups.forEach(({ nodeIds, anchorId }, step) => {
    if (nodeIds.length <= 1) return;
    const { x: ax, y: ay } = cy.getElementById(anchorId).position();
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    nodeIds.forEach((id, i) => {
      const stepsOut = nodeIds.length - 1 - i; // 0 = anchor (innermost)
      cy.getElementById(id).position({
        x: ax + stepsOut * NODE_STACK_SPACING * dx,
        y: ay + stepsOut * NODE_STACK_SPACING * dy,
      });
    });
  });
}

/**
 * Refit the graph to an optimal view: recompute positions for the current
 * container size then fit all elements with padding.
 * Called on resize and by the Fit button.
 */
function fitGraph() {
  if (!cy) return;
  cy.resize();     // sync Cytoscape's internal dimensions with the DOM
  positionNodes(); // recompute circle using new width/height, then cy.fit()
}

/**
 * Place each step's anchor node clockwise around a circle, with position
 * proportional to step index (step 0 = 12 o'clock, increasing clockwise).
 * Then snap chord stacks above their anchors and fit the viewport.
 */
function positionNodes() {
  const containerW = cy.container().clientWidth  || 400;
  const containerH = cy.container().clientHeight || 380;
  const containerMin = Math.min(containerW, containerH);

  const n = stepSequence.length;
  const baseR = containerMin * 0.28;
  // Minimum radius so adjacent anchors have at least 8px gap (node diameter = 38px)
  const minR  = n > 1 ? (38 + 8) / (2 * Math.sin(Math.PI / n)) : 0;
  const r     = Math.max(baseR, minR);
  const cx    = containerW / 2;
  const cy_center = containerH / 2;

  stepSequence.forEach(({ step, anchorId }) => {
    // -π/2 puts step 0 at 12 o'clock; adding a positive fraction goes clockwise
    const angle = -Math.PI / 2 + (step / STEPS) * 2 * Math.PI;
    cy.getElementById(anchorId).position({
      x: cx        + r * Math.cos(angle),
      y: cy_center + r * Math.sin(angle),
    });
  });

  snapChordStacks();
  cy.fit(40);
}

/**
 * Rebuild node/edge state whenever the grid changes.
 *
 * Solo notes  → standalone node, sequence arrows in/out.
 * Chord notes → vertical snowman stack; only the bottom (anchor) node carries
 *               sequence arrows; stack members are joined by thin pipe edges.
 */
function updateGraph() {
  if (!cy) return;

  chordGroups = buildChordGroups();
  stepSequence = [];
  for (let s = 0; s < STEPS; s++) {
    if (chordGroups.has(s)) stepSequence.push({ step: s, ...chordGroups.get(s) });
  }

  // Active set is now keyed by event-node IDs (note@step), not bare note names.
  // This guarantees each occurrence of a pitch is a distinct node — no self-loops.
  const activeIds = new Set([...chordGroups.values()].flatMap(g => g.nodeIds));

  // Clear edges and node highlight tracking
  cy.edges().remove();
  prevPlayingNodes = [];

  // Stop ball and hide it — positions are about to change
  const ball = cy.getElementById('__ball__');
  if (ball.length) { ball.stop(); ball.style('opacity', 0); }

  // Remove stale event-nodes; reset class on still-active ones (never remove the ball)
  cy.nodes().forEach(node => {
    if (node.id() === '__ball__') return;
    if (activeIds.has(node.id())) {
      node.removeClass('playing');
    } else {
      node.remove();
    }
  });

  // Add newly active event-nodes — seed positions on a circle spread by step
  const containerW = cy.container().clientWidth  || 400;
  const containerH = cy.container().clientHeight || 380;
  const r = Math.min(containerW, containerH) * 0.35;
  chordGroups.forEach(({ notes, nodeIds }, step) => {
    notes.forEach((note, i) => {
      const id = nodeIds[i];
      if (cy.getElementById(id).length === 0) {
        const ni = NOTES.indexOf(note);
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

  // ── Chord-stack pipe edges (within each step, high → low, no arrows) ──
  const stackEdges = [];
  chordGroups.forEach(({ nodeIds }, step) => {
    for (let i = 0; i < nodeIds.length - 1; i++) {
      stackEdges.push({
        data: {
          id: `stack-${step}-${i}`,
          source: nodeIds[i],       // higher note (top)
          target: nodeIds[i + 1],  // lower note (towards anchor)
          type: 'chord-stack',
        },
      });
    }
  });

  // ── Sequence edges (anchorId → next anchorId, step distance in length) ──
  const seqEdges = [];
  if (stepSequence.length >= 2) {
    const n = stepSequence.length;
    stepSequence.forEach(({ step, anchorId }, i) => {
      const next = stepSequence[(i + 1) % n];
      let dist = i < n - 1 ? next.step - step : (STEPS - step) + next.step;
      dist = Math.max(dist, 1);
      seqEdges.push({
        data: {
          id: `seq-${i}`,
          source: anchorId,
          target: next.anchorId,
          dist,
          seqIdx: i,
          type: 'sequence',
        },
      });
    });
  }

  cy.add([...stackEdges, ...seqEdges]);

  // Place anchors clockwise on a circle, snap chord stacks, fit viewport
  positionNodes();
}

/**
 * Called on every sequencer tick.
 * Lights up the nodes at the current step, then launches the traversal ball
 * toward the next active chord — respecting the current playback mode direction.
 */
function updateGraphPlayhead(step, nextGridStep) {
  if (!cy) return;

  // Clear previous node highlights
  prevPlayingNodes.forEach(n => n.removeClass('playing'));
  prevPlayingNodes = [];

  if (!chordGroups.has(step)) return;

  // Light up every event-node in the current chord (whole snowman glows)
  chordGroups.get(step).nodeIds.forEach(id => {
    const node = cy.getElementById(id);
    if (node.length) { node.addClass('playing'); prevPlayingNodes.push(node); }
  });

  // Animate the ball from the current anchor to the next anchor
  const ball = cy.getElementById('__ball__');
  if (!ball.length || stepSequence.length < 2) return;

  const srcGroup = chordGroups.get(step);
  if (!srcGroup) return;

  // Find the next active chord at or after nextGridStep in activeStepArray
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

  // Duration = rhythmic gap converted to milliseconds at current BPM
  const stepMs   = (60 / Tone.Transport.bpm.value / 4) * 1000; // one 16th note
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
  document.getElementById('fit-btn').addEventListener('click', fitGraph);

  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel  = document.getElementById('settings-panel');
  settingsToggle.addEventListener('click', () => {
    const collapsed = settingsPanel.classList.toggle('collapsed');
    settingsToggle.textContent = collapsed ? '\u2699 Controls \u25b6' : '\u2699 Controls \u25bc';
    settingsToggle.classList.toggle('open', !collapsed);
  });
  // Start open
  settingsToggle.classList.add('open');

  function makeCollapseToggle(btnId, targetId, afterShow) {
    const btn = document.getElementById(btnId);
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

  // Refit whenever the graph panel is resized (e.g. window resize, devtools)
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
    // Regenerate the convolution IR shortly after the user stops dragging
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
    const slider = document.getElementById(id);
    const display = document.getElementById(valId);
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      setEnvelope(param, val);
      display.textContent = val.toFixed(2) + unit;
    });
  });
});
