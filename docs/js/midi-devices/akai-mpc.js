// Akai MPC Live II / One / X integration. Per-pad RGB via SysEx,
// Q-Link encoders for element control, jog wheel for element selection.
//
// 16 pads in a 4x4 grid. Notes 36-51 (standard GM drum map).
// Direct RGB — no palette management needed.
//
// SysEx format: F0 47 7F [pid] 65 00 04 [pad] [R] [G] [B] F7
// Product IDs: 0x3B=MPC Live, 0x47=MPC Live II, 0x46=MPC One, 0x3A=MPC X.
//
// USB MIDI ports in controller mode:
//   Port 0 (Public)  — SysEx/LED
//   Port 1 (Private) — pads/buttons
// attach() must find the Public output port for LED control.

import { wavelengthToRGB } from '../spectrum.js';

const PAD_BASE = 36;    // Note offset (GM drum map: C1)
const PAD_ROWS = 4;
const PAD_COLS = 4;
const PAD_COUNT = PAD_ROWS * PAD_COLS;

// Q-Link encoder CCs (default controller-mode mapping).
const CC_QLINK1 = 16;
const CC_QLINK4 = 19;
const CC_JOG = 100;

// Known MPC product IDs for SysEx addressing.
const MPC_PIDS = {
  'MPC Live':    0x3B,
  'MPC Live II': 0x47,
  'MPC One':     0x46,
  'MPC X':       0x3A,
};

export function mpcPadNoteToEmitter(note) {
  const k = note - PAD_BASE;
  if (k < 0 || k >= PAD_COUNT) return -1;
  return k;
}

export class MPCController {
  static matches(name) { return name.includes('MPC'); }
  static label = 'MPC 4x4';
  constructor() {
    this.output = null;
    this.sysex = false;
    this.onCC = null;
    this.animating = false;
    this._pid = 0x47; // default: MPC Live II
    this.padMapper = (note) => {
      const k = note - 36;
      return (k >= 0 && k < 16) ? k : -1;
    };

    this.pixels = new Uint8Array(PAD_COUNT * 3);
    this._hwState = new Uint8Array(PAD_COUNT * 3); // track sent RGB
  }

  attach(midiAccess, inputPort) {
    this.output = null;
    this.sysex = false;
    if (!inputPort || !midiAccess) return;

    // Detect product ID from port name.
    const name = inputPort.name || '';
    for (const [key, pid] of Object.entries(MPC_PIDS)) {
      if (name.includes(key)) { this._pid = pid; break; }
    }

    // Find the output port. MPC exposes multiple ports; prefer the
    // one named "Public" or matching the input name.
    for (const out of midiAccess.outputs.values()) {
      if (out.name.includes('Public') || out.name === inputPort.name) {
        this.output = out; break;
      }
    }
    // Fallback: any output from the same device.
    if (!this.output) {
      for (const out of midiAccess.outputs.values()) {
        if (out.name.includes('MPC')) { this.output = out; break; }
      }
    }
    if (!this.output) return;

    // Test SysEx availability.
    try {
      this._sendPadColor(0, 0, 0, 0);
      this.sysex = true;
    } catch { this.sysex = false; }

    this._reset();
    // Clear all pads.
    for (let i = 0; i < PAD_COUNT; i++) this._sendPadColor(i, 0, 0, 0);
    this._playInitAnimation();
  }

  detach() {
    this._stopInitAnimation();
    this.clearPads();
    this.output = null;
  }

  // --- SysEx LED control ---

  _sendPadColor(pad, r, g, b) {
    if (!this.output) return;
    this.output.send([
      0xF0, 0x47, 0x7F, this._pid,
      0x65, 0x00, 0x04,
      pad & 0x0F,
      r & 0x7F,
      g & 0x7F,
      b & 0x7F,
      0xF7,
    ]);
  }

  // --- Pixel map API ---

  setPixel(padIndex, r, g, b) {
    if (padIndex < 0 || padIndex >= PAD_COUNT) return;
    const o = padIndex * 3;
    this.pixels[o] = r; this.pixels[o + 1] = g; this.pixels[o + 2] = b;
  }

  flush() {
    if (!this.output || !this.sysex) return;
    for (let i = 0; i < PAD_COUNT; i++) {
      const o = i * 3;
      const r = this.pixels[o], g = this.pixels[o + 1], b = this.pixels[o + 2];
      // Scale 0-255 to 0-127 for SysEx.
      const r7 = r >> 1, g7 = g >> 1, b7 = b >> 1;
      const ho = o; // hwState uses same layout
      if (this._hwState[ho] !== r7 || this._hwState[ho + 1] !== g7 || this._hwState[ho + 2] !== b7) {
        this._sendPadColor(i, r7, g7, b7);
        this._hwState[ho] = r7;
        this._hwState[ho + 1] = g7;
        this._hwState[ho + 2] = b7;
      }
    }
  }

  // --- Sensor visualization on 4x4 grid ---
  // All 16 pads show a 4x4 spectrogram. Left 3 columns: emitter input
  // levels. Right column: sensor output (dominant wavelength).

  updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime) {
    if (this.animating || !sensorBins) return;
    const levels = runtime.micLevels;
    const nEmitters = emitter.count;
    const disabled = emitter.disabled;

    // Left 3 columns (12 pads): emitter input levels.
    // Map N emitters to 4 rows × 3 columns. Each row = a group of
    // emitters; columns show intensity as brightness ramp.
    for (let row = 0; row < PAD_ROWS; row++) {
      const e0 = Math.floor(row * nEmitters / PAD_ROWS);
      const e1 = Math.min(nEmitters, Math.floor((row + 1) * nEmitters / PAD_ROWS));
      // Find peak level in this emitter group.
      let peak = 0;
      for (let e = e0; e < e1; e++) {
        if (disabled && disabled.has(e)) continue;
        const lv = levels ? (levels[e] || 0) : 1;
        if (lv > peak) peak = lv;
      }
      // Average wavelength for this group.
      const wl = 400 + ((row + 0.5) / PAD_ROWS) * 300;
      const rgb = wavelengthToRGB(wl);
      const br = Math.min(1, peak);
      for (let col = 0; col < 3; col++) {
        // Columns show dim→mid→bright for the group's level.
        const colBr = br * (col + 1) / 3;
        const padIdx = row * PAD_COLS + col;
        this.setPixel(padIdx,
          Math.round(rgb[0] * 255 * colBr),
          Math.round(rgb[1] * 255 * colBr),
          Math.round(rgb[2] * 255 * colBr));
      }
    }

    // Right column (4 pads): sensor spectrogram.
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
      const padIdx = row * PAD_COLS + 3;
      if (totalI > 0.01 && bestV > 0) {
        const rgb = wavelengthToRGB(bestWl);
        this.setPixel(padIdx,
          Math.round(rgb[0] * 255),
          Math.round(rgb[1] * 255),
          Math.round(rgb[2] * 255));
      } else {
        this.setPixel(padIdx, 0, 0, 0);
      }
    }

    this.flush();
  }

  clearPads() {
    this.pixels.fill(0);
    this.flush();
  }

  // --- Init animation: spectral sweep ---

  _initAnimId = 0;
  _initAnimStart = 0;

  _playInitAnimation() {
    this._stopInitAnimation();
    if (!this.output) return;
    this.animating = true;
    this._initAnimStart = performance.now();
    const DURATION = 1500;

    const step = () => {
      const t = performance.now() - this._initAnimStart;
      if (t > DURATION || !this.output) { this._stopInitAnimation(); return; }

      // Decay trail.
      for (let i = 0; i < this.pixels.length; i++) {
        this.pixels[i] = Math.floor(this.pixels[i] * 0.8);
      }

      const fade = t < 200 ? t / 200 : t > DURATION - 300 ? (DURATION - t) / 300 : 1;
      // Sweep a spectral band across the grid.
      const phase = (t / DURATION) * (PAD_COUNT + 2);
      for (let i = 0; i < PAD_COUNT; i++) {
        const dist = Math.abs(i - phase);
        if (dist < 2) {
          const wl = 400 + (i / PAD_COUNT) * 300;
          const rgb = wavelengthToRGB(wl);
          const br = Math.max(0, 1 - dist / 2) * fade;
          this.setPixel(i,
            Math.round(rgb[0] * 255 * br),
            Math.round(rgb[1] * 255 * br),
            Math.round(rgb[2] * 255 * br));
        }
      }

      this.flush();
      this._initAnimId = requestAnimationFrame(step);
    };
    this._initAnimId = requestAnimationFrame(step);
  }

  _stopInitAnimation() {
    if (this._initAnimId) { cancelAnimationFrame(this._initAnimId); this._initAnimId = 0; }
    this.animating = false;
    this.pixels.fill(0);
    if (this.output) this.flush();
  }

  // --- CC dispatch ---

  handleCC(cc, val) {
    if (cc >= CC_QLINK1 && cc <= CC_QLINK4) {
      // Q-Link encoders: relative around 64.
      if (this.onCC) {
        // Remap Q-Link CCs (16-19) to match Push encoder CCs (71-74)
        // so the same onCC handler in main.js works for both.
        const pushCC = 71 + (cc - CC_QLINK1);
        this.onCC(pushCC, val);
        return true;
      }
    }
    if (cc === CC_JOG) {
      // Jog wheel: remap to Push's selection wheel (CC 70).
      if (this.onCC) { this.onCC(70, val); return true; }
    }
    return false;
  }

  // Scale is unused on 4x4 grid (pads map 1:1 to emitters, no in-key layout).
  setScale(_scaleName) {}
}
