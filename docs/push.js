// Ableton Push 2/3 integration. Owns the MIDI output port, pad LED
// pixel map, palette management, sensor-to-pad color mapping, and
// encoder-to-element dispatch.
//
// Push hardware uses a FIXED note-to-pad mapping: note 36 = bottom-left,
// note 37 = next right, note 99 = top-right. Always. The in-key scale
// layout is Ableton Live software, not the Push hardware. Without Live,
// pads send sequential notes 36-99. LED addressing is the same: send
// Note On for note N to light pad N, one pad per note, no overlap.
//
// See notes/push-midi-map.md for the full reference.

import { wavelengthToRGB, SCALES } from './spectrum.js';
import { makeElement, localPolygon } from './scene.js';

const PAD_BASE = 36;
const PAD_ROWS = 8;
const PAD_COLS = 8;
const PAD_COUNT = PAD_ROWS * PAD_COLS;
const PALETTE_SIZE = 128;

function colorKey(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}
function keyToRgb(key) {
  return [
    ((key >> 10) & 0x1F) << 3,
    ((key >> 5) & 0x1F) << 3,
    (key & 0x1F) << 3,
  ];
}

// In-key layout: pad (row, col) → scale degree = row * rowOffset + col.
// The row offset = how many scale degrees make a perfect fourth (5
// semitones). Varies by scale: chromatic=5, major/minor=3, pentaMajor=2.
// Computed from the semitone array so it adapts to any scale.
function fourthOffset(semitones) {
  // Find the scale degree whose semitone value is closest to 5 (perfect fourth).
  let best = 0, bestDist = 99;
  for (let i = 0; i < semitones.length; i++) {
    const d = Math.abs(semitones[i] - 5);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return Math.max(1, best);
}

// Module-level state set by PushController.setScale().
let _rowOffset = 3;
let _scaleLength = 7;

function padToDegree(padIndex) {
  const row = Math.floor(padIndex / PAD_COLS);
  const col = padIndex % PAD_COLS;
  return row * _rowOffset + col;
}

// Pad note → emitter index (= scale degree). Exported for mic.js.
export function padNoteToEmitter(note) {
  const k = note - PAD_BASE;
  if (k < 0 || k >= PAD_COUNT) return -1;
  return padToDegree(k);
}

export class PushController {
  constructor() {
    this.output = null;
    this.sysex = false;
    this.onCC = null;

    // 8x8 pixel map (source of truth). Index = pad index (0-63), 3 bytes per pixel.
    this.pixels = new Uint8Array(PAD_COUNT * 3);

    // Palette state on the Push.
    this._keyToIdx = new Map();
    this._idxToKey = new Int32Array(PALETTE_SIZE).fill(-1);
    this._idxRefCount = new Uint8Array(PALETTE_SIZE);
    this._nextFreeSearch = 1;

    // Current vs desired palette index per pad.
    this._hwState = new Uint8Array(PAD_COUNT);
    this._wantState = new Uint8Array(PAD_COUNT);
  }

  attach(midiAccess, inputPort) {
    this.output = null;
    this.sysex = false;
    if (!inputPort || !midiAccess) return;
    for (const out of midiAccess.outputs.values()) {
      if (out.name === inputPort.name) { this.output = out; break; }
    }
    if (this.output) {
      try { this._sendPaletteEntry(1, 0, 0, 0); this.sysex = true; }
      catch { this.sysex = false; }
    }
    this._reset();
    // Force all pads off on the hardware — the Push may still show
    // LEDs from a previous session or Ableton's startup state.
    // _hwState is zero (from _reset) but the hardware doesn't know that.
    for (let i = 0; i < PAD_COUNT; i++) {
      this.output.send([0x90, PAD_BASE + i, 0]);
    }
    this._playInitAnimation();
  }

  detach() {
    this._stopInitAnimation();
    this.clearPads();
    this.output = null;
  }

  // Update scale layout. Called from main.js when mode changes.
  setScale(scaleName) {
    const semi = SCALES[scaleName] || SCALES.chromatic;
    _rowOffset = fourthOffset(semi);
    _scaleLength = semi.length;
  }

  _reset() {
    this.pixels.fill(0);
    this._keyToIdx.clear();
    this._idxToKey.fill(-1);
    this._idxRefCount.fill(0);
    this._nextFreeSearch = 1;
    this._hwState.fill(0);
    this._wantState.fill(0);
  }

  // --- Pixel map API ---

  setPixel(padIndex, r, g, b) {
    const o = padIndex * 3;
    this.pixels[o] = r; this.pixels[o + 1] = g; this.pixels[o + 2] = b;
  }

  // Diff pixel map against hardware state, send minimum MIDI.
  flush() {
    const out = this.output;
    if (!out) return;

    for (let i = 0; i < PAD_COUNT; i++) {
      const o = i * 3;
      const r = this.pixels[o], g = this.pixels[o + 1], b = this.pixels[o + 2];
      if (r === 0 && g === 0 && b === 0) {
        this._wantState[i] = 0;
      } else {
        const key = colorKey(r, g, b);
        let idx = this._keyToIdx.get(key);
        if (idx === undefined) idx = this._allocPaletteEntry(key, r, g, b);
        this._wantState[i] = idx;
      }
    }

    const oldRef = new Uint8Array(this._idxRefCount);
    this._idxRefCount.fill(0);

    // Send lit pads first, black pads last — avoids a visible
    // flash-to-black when transitioning between animation and normal
    // rendering.  Two passes, same diff logic.
    for (let i = 0; i < PAD_COUNT; i++) {
      const want = this._wantState[i];
      if (want > 0) this._idxRefCount[want]++;
      if (want > 0 && want !== this._hwState[i]) {
        out.send([0x90, PAD_BASE + i, want]);
        this._hwState[i] = want;
      }
    }
    for (let i = 0; i < PAD_COUNT; i++) {
      const want = this._wantState[i];
      if (want === 0 && this._hwState[i] !== 0) {
        out.send([0x90, PAD_BASE + i, 0]);
        this._hwState[i] = 0;
      }
    }

    for (let idx = 1; idx < PALETTE_SIZE; idx++) {
      if (oldRef[idx] > 0 && this._idxRefCount[idx] === 0) {
        const key = this._idxToKey[idx];
        if (key >= 0) this._keyToIdx.delete(key);
        this._idxToKey[idx] = -1;
      }
    }
  }

  _allocPaletteEntry(key, r, g, b) {
    let idx = -1;
    for (let tries = 0; tries < PALETTE_SIZE - 1; tries++) {
      const c = ((this._nextFreeSearch + tries - 1) % (PALETTE_SIZE - 1)) + 1;
      if (this._idxRefCount[c] === 0 && this._idxToKey[c] < 0) {
        idx = c; this._nextFreeSearch = c + 1; break;
      }
    }
    if (idx < 0) {
      idx = this._nextFreeSearch;
      if (idx < 1 || idx >= PALETTE_SIZE) idx = 1;
      this._nextFreeSearch = idx + 1;
      const oldKey = this._idxToKey[idx];
      if (oldKey >= 0) this._keyToIdx.delete(oldKey);
    }
    this._keyToIdx.set(key, idx);
    this._idxToKey[idx] = key;
    if (this.sysex) {
      const [qr, qg, qb] = keyToRgb(key);
      this._sendPaletteEntry(idx, qr, qg, qb);
    }
    return idx;
  }

  _sendPaletteEntry(idx, r, g, b) {
    this.output.send([
      0xF0, 0x00, 0x21, 0x1D, 0x01, 0x01, 0x03, idx,
      r & 0x7F, (r >> 7) & 0x01,
      g & 0x7F, (g >> 7) & 0x01,
      b & 0x7F, (b >> 7) & 0x01,
      0, 0,
      0xF7
    ]);
  }

  // --- Init animation: rotating triangle ---

  _initAnimId = 0;
  _initAnimStart = 0;
  animating = false;

  // Play a rotating polygon animation. `kind` is any element kind
  // ('prism', 'block', 'lens-convex', 'mirror', 'circle', 'rabbit', etc.)
  // whose localPolygon is normalized and rotated on the 8x8 grid.
  // Defaults to 'prism'. Duration in ms (default 2000).
  playAnimation(kind = 'prism', duration = 2000) {
    this._stopInitAnimation();
    if (!this.output) return;

    // Get the element's local polygon and normalize to fit the grid.
    const el = makeElement(kind, 0, 0);
    const poly = localPolygon(el);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    const pw = maxX - minX || 1, ph = maxY - minY || 1;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const scale = 6 / Math.max(pw, ph); // fit within ~6 of 8 cells
    const normPoly = poly.map(p => ({
      x: (p.x - cx) * scale,
      y: (p.y - cy) * scale,
    }));
    const n = normPoly.length;

    this.animating = true;
    this._initAnimStart = performance.now();
    const GCX = 3.5, GCY = 3.5;

    const step = () => {
      const t = performance.now() - this._initAnimStart;
      if (t > duration || !this.output) { this._stopInitAnimation(); return; }

      // Decay for trailing glow.
      for (let i = 0; i < this.pixels.length; i++) {
        this.pixels[i] = Math.floor(this.pixels[i] * 0.85);
      }

      const angle = (t / 600) * Math.PI;
      const fade = t < 300 ? t / 300 : t > duration - 400 ? (duration - t) / 400 : 1;
      const cos = Math.cos(angle), sin = Math.sin(angle);

      // Rotate and draw each edge with a spectral color.
      for (let i = 0; i < n; i++) {
        const a = normPoly[i], b = normPoly[(i + 1) % n];
        const ax = GCX + a.x * cos - a.y * sin;
        const ay = GCY + a.x * sin + a.y * cos;
        const bx = GCX + b.x * cos - b.y * sin;
        const by = GCY + b.x * sin + b.y * cos;
        const wl = 400 + (i / n) * 340;
        const rgb = wavelengthToRGB(wl);
        this._bresenham(ax, ay, bx, by,
          Math.round(rgb[0] * 255 * fade),
          Math.round(rgb[1] * 255 * fade),
          Math.round(rgb[2] * 255 * fade));
      }

      this.flush();
      this._initAnimId = requestAnimationFrame(step);
    };
    this._initAnimId = requestAnimationFrame(step);
  }

  _playInitAnimation() { this.playAnimation('prism'); }

  _stopInitAnimation() {
    if (this._initAnimId) { cancelAnimationFrame(this._initAnimId); this._initAnimId = 0; }
    this.animating = false;
    this.pixels.fill(0);
    if (this.output) this.flush();
  }

  // Bresenham line on the 8x8 pixel grid. Plots with additive blending
  // so overlapping edges mix rather than overwrite.
  _bresenham(x0, y0, x1, y1, r, g, b) {
    let ix0 = Math.round(x0), iy0 = Math.round(y0);
    let ix1 = Math.round(x1), iy1 = Math.round(y1);
    const dx = Math.abs(ix1 - ix0), dy = -Math.abs(iy1 - iy0);
    const sx = ix0 < ix1 ? 1 : -1, sy = iy0 < iy1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (ix0 >= 0 && ix0 < PAD_COLS && iy0 >= 0 && iy0 < PAD_ROWS) {
        const o = (iy0 * PAD_COLS + ix0) * 3;
        this.pixels[o]     = Math.min(255, this.pixels[o]     + r);
        this.pixels[o + 1] = Math.min(255, this.pixels[o + 1] + g);
        this.pixels[o + 2] = Math.min(255, this.pixels[o + 2] + b);
      }
      if (ix0 === ix1 && iy0 === iy1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; ix0 += sx; }
      if (e2 <= dx) { err += dx; iy0 += sy; }
    }
  }

  // --- High-level: update pixel map from sensor/emitter state ---

  updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime) {
    if (this.animating) return;
    const scaleLength = _scaleLength;
    if (!sensorBins) return;
    const disabled = emitter.disabled;
    const levels = runtime.micLevels;
    const nEmitters = emitter.count;

    // --- Pass 1: in-key layout for all 64 pads ---
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const deg = padToDegree(pad);
      const e = deg;
      const inRange = e < nEmitters;
      const isRoot = scaleLength > 0 && (deg % scaleLength) === 0;
      if (!inRange || (disabled && disabled.has(e))) {
        this.setPixel(pad, 0, 0, 0);
      } else if (levels && levels[e] > 0.01) {
        this.setPixel(pad, 255, 200, 0);
      } else if (isRoot) {
        this.setPixel(pad, 0, 40, 0);
      } else {
        this.setPixel(pad, 0, 30, 40);
      }
    }

    // --- Pass 2: rightmost column = downsampled sensor spectrogram ---
    // 8 LEDs (col 7, rows 0-7). Each LED aggregates sensorCount/8
    // sensors. Row 0 = bottom = top-of-bench sensors. Non-zero
    // overrides whatever the in-key layout set at that pad.
    for (let row = 0; row < PAD_ROWS; row++) {
      // Flip: row 0 (bottom pad) = bottom-of-bench sensors, row 7 (top) = top.
      const flipped = PAD_ROWS - 1 - row;
      const s0 = Math.floor(flipped * sensorCount / PAD_ROWS);
      const s1 = Math.min(sensorCount, Math.floor((flipped + 1) * sensorCount / PAD_ROWS));
      // Find the dominant wavelength bin (highest intensity) across the
      // sensor group — shows the strongest color, not a washed-out average.
      let bestV = 0, bestWl = 0, totalI = 0;
      for (let s = s0; s < s1; s++) {
        for (let b = 0; b < binCount; b++) {
          const v = sensorBins[s * binCount + b];
          totalI += v;
          if (v > bestV) { bestV = v; bestWl = 380 + (b + 0.5) / binCount * 400; }
        }
      }
      if (totalI > 0.01 && bestV > 0) {
        const rgb = wavelengthToRGB(bestWl);
        const padIdx = row * PAD_COLS + (PAD_COLS - 1);
        this.setPixel(padIdx,
          Math.round(rgb[0] * 255),
          Math.round(rgb[1] * 255),
          Math.round(rgb[2] * 255));
      }
    }

    this.flush();
  }

  clearPads() {
    this.pixels.fill(0);
    this.flush();
  }

  handleCC(cc, val) {
    if (this.onCC) { this.onCC(cc, val); return true; }
    return false;
  }
}
