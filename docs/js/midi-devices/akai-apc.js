// Akai APC Mini MK2 / APC64 integration. 8x8 RGB pad grid with
// direct per-pad RGB via SysEx, fader-to-element control, and
// in-key scale layout matching Push.
//
// 64 pads in an 8x8 grid. Notes 0x00-0x3F (0-63).
// Bottom-left = 0x00, bottom-right = 0x07, top-left = 0x38.
// Formula: note = row * 8 + col (row 0 = bottom).
//
// LED control — two methods:
//   1. Fixed palette: Note On [0x96, pad, velocity] (128 colors, no custom)
//   2. Direct RGB via SysEx (APC Mini MK2):
//      F0 47 7F 4F 24 [lenMSB] [lenLSB] [startPad] [endPad]
//        [rMSB] [rLSB] [gMSB] [gLSB] [bMSB] [bLSB] ... F7
//      14-bit per channel (MSB<<7 | LSB). Can batch pad ranges.
//
// Faders (APC Mini MK2): CC 48-56 (9 faders, absolute 0-127).
// Track buttons: notes 0x64-0x6B. Scene launch: notes 0x70-0x77.

import { wavelengthToRGB, SCALES } from '../spectrum.js';
import { makeElement, localPolygon } from '../scene.js';

const PAD_ROWS = 8;
const PAD_COLS = 8;
const PAD_COUNT = PAD_ROWS * PAD_COLS;
const APC_PID = 0x4F;  // APC Mini MK2

// Fader CCs.
const CC_FADER_BASE = 48;
const CC_FADER_COUNT = 9;

// In-key layout (shared logic with Push).
function fourthOffset(semitones) {
  let best = 0, bestDist = 99;
  for (let i = 0; i < semitones.length; i++) {
    const d = Math.abs(semitones[i] - 5);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return Math.max(1, best);
}

let _rowOffset = 3;
let _scaleLength = 7;

function padToDegree(padIndex) {
  const row = Math.floor(padIndex / PAD_COLS);
  const col = padIndex % PAD_COLS;
  return row * _rowOffset + col;
}

// Pad note → emitter index. Exported for mic.js pad mapper.
export function apcPadNoteToEmitter(note) {
  if (note < 0 || note >= PAD_COUNT) return -1;
  return padToDegree(note);
}

export class APCController {
  static matches(name) { return name.includes('APC'); }
  static label = 'APC 8x8';
  constructor() {
    this.output = null;
    this.sysex = false;
    this.onCC = null;
    this.animating = false;
    this.padMapper = apcPadNoteToEmitter;

    this.pixels = new Uint8Array(PAD_COUNT * 3);
    this._hwState = new Uint8Array(PAD_COUNT * 3);

    // Fader pickup state: faders are absolute (0-127). To avoid
    // property jumps on first touch, ignore fader until it crosses
    // the last-sent value (pickup mode).
    this._faderPickup = new Float32Array(CC_FADER_COUNT).fill(-1);
    this._faderLast = new Float32Array(CC_FADER_COUNT).fill(-1);
  }

  attach(midiAccess, inputPort) {
    this.output = null;
    this.sysex = false;
    if (!inputPort || !midiAccess) return;

    // Find matching output port.
    for (const out of midiAccess.outputs.values()) {
      if (out.name === inputPort.name) { this.output = out; break; }
    }
    if (!this.output) {
      for (const out of midiAccess.outputs.values()) {
        if (out.name.includes('APC')) { this.output = out; break; }
      }
    }
    if (!this.output) return;

    // Test SysEx.
    try {
      this._sendPadRgb(0, 0, 0, 0, 0);
      this.sysex = true;
    } catch { this.sysex = false; }

    this._reset();
    // Clear all pads.
    for (let i = 0; i < PAD_COUNT; i++) {
      this.output.send([0x96, i, 0]); // ch 6 (100%), vel 0 = off
    }
    this._faderPickup.fill(-1);
    this._faderLast.fill(-1);
    this._playInitAnimation();
  }

  detach() {
    this._stopInitAnimation();
    this.clearPads();
    this.output = null;
  }

  _reset() {
    this.pixels.fill(0);
    this._hwState.fill(0);
  }

  // --- SysEx LED control ---

  // Send RGB to a single pad via SysEx.
  _sendPadRgb(pad, r, g, b) {
    if (!this.output) return;
    // 14-bit encoding: value = (MSB << 7) | LSB.
    const rM = (r >> 1) & 0x7F, rL = (r & 1) ? 0x40 : 0;
    const gM = (g >> 1) & 0x7F, gL = (g & 1) ? 0x40 : 0;
    const bM = (b >> 1) & 0x7F, bL = (b & 1) ? 0x40 : 0;
    const dataLen = 8; // startPad + endPad + 6 color bytes
    this.output.send([
      0xF0, 0x47, 0x7F, APC_PID, 0x24,
      (dataLen >> 7) & 0x7F, dataLen & 0x7F,
      pad & 0x3F, pad & 0x3F,
      rM, rL, gM, gL, bM, bL,
      0xF7,
    ]);
  }

  // Batch send RGB to a range of contiguous pads.
  _sendPadRgbBatch(startPad, rgbArray) {
    if (!this.output || rgbArray.length === 0) return;
    const count = rgbArray.length / 3;
    const endPad = startPad + count - 1;
    const dataLen = 2 + count * 6; // start + end + 6 bytes per pad
    const msg = [
      0xF0, 0x47, 0x7F, APC_PID, 0x24,
      (dataLen >> 7) & 0x7F, dataLen & 0x7F,
      startPad & 0x3F, endPad & 0x3F,
    ];
    for (let i = 0; i < count; i++) {
      const r = rgbArray[i * 3], g = rgbArray[i * 3 + 1], b = rgbArray[i * 3 + 2];
      msg.push((r >> 1) & 0x7F, (r & 1) ? 0x40 : 0);
      msg.push((g >> 1) & 0x7F, (g & 1) ? 0x40 : 0);
      msg.push((b >> 1) & 0x7F, (b & 1) ? 0x40 : 0);
    }
    msg.push(0xF7);
    this.output.send(msg);
  }

  // Fallback: fixed palette via velocity. Find closest palette color.
  _sendPadPalette(pad, r, g, b) {
    if (!this.output) return;
    // Velocity 0 = off, 5 = red, 87 = green, 67 = blue, 3 = white.
    // Simple: if all zero, vel 0. Otherwise pick nearest from a small set.
    if (r === 0 && g === 0 && b === 0) {
      this.output.send([0x96, pad, 0]);
      return;
    }
    // Rough nearest-color from the fixed 128 palette is impractical
    // without the full table. Use a basic hue→velocity mapping.
    const max = Math.max(r, g, b);
    if (max < 10) { this.output.send([0x96, pad, 0]); return; }
    // Default to white-ish.
    let vel = 3;
    if (r > g && r > b) vel = 5;       // red
    else if (g > r && g > b) vel = 87;  // green
    else if (b > r && b > g) vel = 67;  // blue
    else if (r > 100 && g > 100) vel = 9; // orange/yellow
    this.output.send([0x96, pad, vel]);
  }

  // --- Pixel map API ---

  setPixel(padIndex, r, g, b) {
    if (padIndex < 0 || padIndex >= PAD_COUNT) return;
    const o = padIndex * 3;
    this.pixels[o] = r; this.pixels[o + 1] = g; this.pixels[o + 2] = b;
  }

  flush() {
    if (!this.output) return;

    if (this.sysex) {
      // Batch contiguous changed pads into SysEx messages.
      let batchStart = -1;
      const batchRgb = [];

      const sendBatch = () => {
        if (batchStart >= 0 && batchRgb.length > 0) {
          this._sendPadRgbBatch(batchStart, batchRgb);
        }
        batchStart = -1;
        batchRgb.length = 0;
      };

      for (let i = 0; i < PAD_COUNT; i++) {
        const o = i * 3;
        const r = this.pixels[o], g = this.pixels[o + 1], b = this.pixels[o + 2];
        if (r !== this._hwState[o] || g !== this._hwState[o + 1] || b !== this._hwState[o + 2]) {
          if (batchStart < 0) batchStart = i;
          else if (i !== batchStart + batchRgb.length / 3) {
            sendBatch();
            batchStart = i;
          }
          batchRgb.push(r, g, b);
          this._hwState[o] = r;
          this._hwState[o + 1] = g;
          this._hwState[o + 2] = b;
        } else {
          sendBatch();
        }
      }
      sendBatch();
    } else {
      // Fallback: palette mode.
      for (let i = 0; i < PAD_COUNT; i++) {
        const o = i * 3;
        const r = this.pixels[o], g = this.pixels[o + 1], b = this.pixels[o + 2];
        if (r !== this._hwState[o] || g !== this._hwState[o + 1] || b !== this._hwState[o + 2]) {
          this._sendPadPalette(i, r, g, b);
          this._hwState[o] = r;
          this._hwState[o + 1] = g;
          this._hwState[o + 2] = b;
        }
      }
    }
  }

  // --- In-key layout + sensor visualization ---
  // Same two-pass rendering as Push: 64 pads with scale layout,
  // rightmost column overridden by sensor spectrogram.

  setScale(scaleName) {
    const semi = SCALES[scaleName] || SCALES.chromatic;
    _rowOffset = fourthOffset(semi);
    _scaleLength = semi.length;
  }

  updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime) {
    if (this.animating || !sensorBins) return;
    const scaleLength = _scaleLength;
    const disabled = emitter.disabled;
    const levels = runtime.micLevels;
    const nEmitters = emitter.count;

    // Pass 1: in-key layout for all 64 pads.
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const deg = padToDegree(pad);
      const inRange = deg < nEmitters;
      const isRoot = scaleLength > 0 && (deg % scaleLength) === 0;
      if (!inRange || (disabled && disabled.has(deg))) {
        this.setPixel(pad, 0, 0, 0);
      } else if (levels && levels[deg] > 0.01) {
        this.setPixel(pad, 255, 200, 0);
      } else if (isRoot) {
        this.setPixel(pad, 0, 40, 0);
      } else {
        this.setPixel(pad, 0, 30, 40);
      }
    }

    // Pass 2: rightmost column = sensor spectrogram.
    for (let row = 0; row < PAD_ROWS; row++) {
      const s0 = Math.floor(row * sensorCount / PAD_ROWS);
      const s1 = Math.min(sensorCount, Math.floor((row + 1) * sensorCount / PAD_ROWS));
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

  // --- Fader → element control with pickup mode ---

  handleCC(cc, val) {
    // Faders: CC 48-56 (absolute 0-127).
    if (cc >= CC_FADER_BASE && cc < CC_FADER_BASE + CC_FADER_COUNT) {
      const idx = cc - CC_FADER_BASE;

      // Fader 9 (CC 56) = volume — absolute, no pickup needed.
      if (idx === 8) {
        if (this.onCC) this.onCC(79, val >= 64 ? 65 : 63);
        return true;
      }

      // Pickup mode: ignore until the fader crosses the last known value.
      if (this._faderPickup[idx] < 0) {
        this._faderPickup[idx] = val;
        return true;
      }
      const prev = this._faderPickup[idx];
      this._faderPickup[idx] = val;
      const delta = val - prev;
      if (delta === 0) return true;

      // Convert absolute delta to relative-around-64 for the shared handler.
      if (this.onCC) {
        // Map faders 0-7 to Push encoder CCs 71-78.
        const pushCC = 71 + idx;
        // Scale delta: fader moves ~1-3 per frame, encoder expects ±1.
        const rel = 64 + Math.sign(delta);
        this.onCC(pushCC, rel);
      }
      return true;
    }

    // Track buttons (notes 0x64-0x6B): element selection.
    // Scene launch buttons (notes 0x70-0x77): could map to presets.
    // For now, pass through to onCC for transport/utility handling.
    if (this.onCC) { this.onCC(cc, val); return true; }
    return false;
  }

  // --- Init animation: rotating polygon (same as Push) ---

  _initAnimId = 0;
  _initAnimStart = 0;

  playAnimation(kind = 'prism', duration = 2000) {
    this._stopInitAnimation();
    if (!this.output) return;

    const el = makeElement(kind, 0, 0);
    const poly = localPolygon(el);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    const pw = maxX - minX || 1, ph = maxY - minY || 1;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const scale = 6 / Math.max(pw, ph);
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

      for (let i = 0; i < this.pixels.length; i++) {
        this.pixels[i] = Math.floor(this.pixels[i] * 0.85);
      }

      const angle = (t / 600) * Math.PI;
      const fade = t < 300 ? t / 300 : t > duration - 400 ? (duration - t) / 400 : 1;
      const cos = Math.cos(angle), sin = Math.sin(angle);

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
}
