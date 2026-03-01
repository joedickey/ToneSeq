# ToneSeq

Browser-based step sequencer and drum machine with live pattern switching and graph visualization.

## Quick Start

**Play it now:** [toneseq.com](https://toneseq.com/)

Or clone and open `index.html` directly — no build step, no server required.

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

## Tech

Built with [Tone.js](https://tonejs.github.io/) for audio synthesis and [Cytoscape.js](https://js.cytoscape.org/) for graph visualization. Pure HTML/CSS/JS — no framework, no build step, no server.

## Note

Best experienced on desktop in Chrome, Firefox, or Safari. The interface is designed for full-screen desktop use.
