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

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

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
    this._connectDisplay();
  }

  detach() {
    this._stopInitAnimation();
    this._disconnectDisplay();
    this.clearPads();
    this.output = null;
  }

  // --- Display WebSocket (optional, connects to tools/push-display.js) ---

  _displayWs = null;
  displayConnected = false;
  static DISPLAY_URL = 'ws://localhost:9100';
  static DISPLAY_W = 960;
  static DISPLAY_H = 160;

  _displayRetryTimer = 0;

  _connectDisplay() {
    if (this._displayWs) return;
    try {
      const ws = new WebSocket(PushController.DISPLAY_URL);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.displayConnected = true;
        this._displayRetryTimer = 0;
      };
      ws.onclose = () => {
        this.displayConnected = false;
        this._displayWs = null;
        this._scheduleDisplayRetry();
      };
      ws.onerror = () => {
        this.displayConnected = false;
        this._displayWs = null;
      };
      this._displayWs = ws;
    } catch {
      this._scheduleDisplayRetry();
    }
  }

  _scheduleDisplayRetry() {
    if (this._displayRetryTimer || !this.output) return;
    this._displayRetryTimer = setTimeout(() => {
      this._displayRetryTimer = 0;
      if (this.output && !this._displayWs) this._connectDisplay();
    }, 2000);
  }

  _disconnectDisplay() {
    if (this._displayRetryTimer) { clearTimeout(this._displayRetryTimer); this._displayRetryTimer = 0; }
    if (this._displayWs) {
      try { this._displayWs.close(); } catch {}
      this._displayWs = null;
      this.displayConnected = false;
    }
  }

  // Send a raw 16-bit RGB565 frame to the display helper. The helper
  // handles the XOR mask and USB bulk transfer. `buf` should be
  // HEIGHT * (WIDTH*2 + 128) bytes = 327,680 bytes.
  sendDisplayFrame(buf) {
    if (!this._displayWs || this._displayWs.readyState !== 1) return;
    this._displayWs.send(buf);
  }

  // Built-in hello: spectral gradient with "CHROMAVOX" text.
  _sendHelloDisplay() {
    const W = PushController.DISPLAY_W, H = PushController.DISPLAY_H;
    const LINE_STRIDE = W * 2 + 128;
    const buf = new Uint8Array(H * LINE_STRIDE);
    for (let y = 0; y < H; y++) {
      const off = y * LINE_STRIDE;
      for (let x = 0; x < W; x++) {
        const hue = (x / W) * 360;
        const l = 0.12 + 0.08 * Math.sin(y / H * Math.PI);
        const [r, g, b] = hslToRgb(hue, 0.8, l);
        const v = ((r >> 3) & 0x1F) | (((g >> 2) & 0x3F) << 5) | (((b >> 3) & 0x1F) << 11);
        buf[off + x * 2] = v & 0xFF;
        buf[off + x * 2 + 1] = (v >> 8) & 0xFF;
      }
    }
    // Crude 5x7 text "CHROMAVOX" centered.
    const CHARS = {
      C:[0x0E,0x11,0x10,0x10,0x10,0x11,0x0E], H:[0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
      R:[0x1E,0x11,0x11,0x1E,0x14,0x12,0x11], O:[0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
      M:[0x11,0x1B,0x15,0x15,0x11,0x11,0x11], A:[0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],
      V:[0x11,0x11,0x11,0x11,0x0A,0x0A,0x04], X:[0x11,0x0A,0x04,0x04,0x04,0x0A,0x11],
    };
    const text = 'CHROMAVOX', cw = 5, ch = 7, sc = 3, gap = 2;
    const tw = text.length * (cw * sc + gap) - gap;
    const sx = Math.floor((W - tw) / 2), sy = Math.floor((H - ch * sc) / 2);
    for (let ci = 0; ci < text.length; ci++) {
      const gl = CHARS[text[ci]]; if (!gl) continue;
      const ox = sx + ci * (cw * sc + gap);
      for (let r = 0; r < ch; r++) {
        for (let c = 0; c < cw; c++) {
          if (!(gl[r] & (1 << (cw - 1 - c)))) continue;
          for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
            const px = ox + c * sc + dx, py = sy + r * sc + dy;
            if (px < 0 || px >= W || py < 0 || py >= H) continue;
            const o = py * LINE_STRIDE + px * 2;
            buf[o] = 0xFF; buf[o + 1] = 0xFF;
          }
        }
      }
    }
    this.sendDisplayFrame(buf);
  }

  // --- Display: sensor spectrograms from right-panel canvases ---

  // Grab the sensor-readout canvases, downscale them into the right
  // portion of the Push display frame, and send. The hello background
  // is regenerated as a dim gradient on the left; sensor bars fill the
  // right side. Called from main.js frame loop when displayConnected.
  _displayBuf = null;
  _scratchCanvas = null;
  _scratchCtx = null;

  _lastDisplaySend = 0;

  // Send a rectangular region of RGB565 pixels to the display helper.
  // The helper composites it onto its cached background frame.
  // Message format: 8-byte header [x_lo, x_hi, y_lo, y_hi, w_lo, w_hi, h_lo, h_hi]
  //                + w * h * 2 bytes of RGB565 pixel data.
  // Send a region as PNG: 8-byte header (x, y as uint16 LE) + PNG data.
  // Width/height come from the PNG itself. Async (canvas.toBlob).
  _sendRegionPng(x, y, canvas) {
    if (!this._displayWs || this._displayWs.readyState !== 1) return;
    const ws = this._displayWs;
    canvas.toBlob(blob => {
      if (!blob || !ws || ws.readyState !== 1) return;
      blob.arrayBuffer().then(ab => {
        const header = new Uint8Array(4);
        header[0] = x & 0xFF; header[1] = (x >> 8) & 0xFF;
        header[2] = y & 0xFF; header[3] = (y >> 8) & 0xFF;
        const msg = new Uint8Array(4 + ab.byteLength);
        msg.set(header);
        msg.set(new Uint8Array(ab), 4);
        ws.send(msg);
      });
    }, 'image/png');
  }

  _scratchCanvas = null;
  _scratchCtx = null;

  // Send bench canvas (downscaled, left) + sensor spectrograms (right)
  // as two region updates. Throttled to ~10fps.
  updateDisplay(sensorBins, binCount, sensorCount, glCanvas) {
    if (!this.displayConnected || !sensorBins) return;
    const now = performance.now();
    if (now - this._lastDisplaySend < 100) return;
    this._lastDisplaySend = now;

    const W = PushController.DISPLAY_W, H = PushController.DISPLAY_H;
    const specW = Math.floor(W * 0.1);

    // Ensure scratch canvases exist.
    if (!this._scratchCanvas) {
      this._scratchCanvas = document.createElement('canvas');
      this._scratchCtx = this._scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this._specCanvas) {
      this._specCanvas = document.createElement('canvas');
      this._specCtx = this._specCanvas.getContext('2d');
    }

    // --- Bench region (left): GL readPixels → full-size canvas → drawImage downscale → PNG ---
    // Using drawImage for bilinear filtering so thin rays survive the downsample.
    let benchRenderedW = 0;
    if (glCanvas) {
      const gl = glCanvas.getContext('webgl2');
      if (gl) {
        const sw = glCanvas.width, sh = glCanvas.height;
        const dw = Math.round(H * (sw / sh));
        const dh = H;
        benchRenderedW = dw;

        if (!this._glReadBuf || this._glReadBuf.length !== sw * sh * 4) {
          this._glReadBuf = new Uint8Array(sw * sh * 4);
        }
        gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, this._glReadBuf);

        // Blit GL pixels to a full-size offscreen canvas (Y-flipped).
        if (!this._glCanvas2d) {
          this._glCanvas2d = document.createElement('canvas');
          this._glCtx2d = this._glCanvas2d.getContext('2d');
        }
        this._glCanvas2d.width = sw;
        this._glCanvas2d.height = sh;
        const fullImg = this._glCtx2d.createImageData(sw, sh);
        const src = this._glReadBuf;
        const dst = fullImg.data;
        for (let y = 0; y < sh; y++) {
          const srcRow = (sh - 1 - y) * sw * 4;
          const dstRow = y * sw * 4;
          for (let x = 0; x < sw; x++) {
            const si = srcRow + x * 4, di = dstRow + x * 4;
            dst[di] = src[si]; dst[di+1] = src[si+1];
            dst[di+2] = src[si+2]; dst[di+3] = 255;
          }
        }
        this._glCtx2d.putImageData(fullImg, 0, 0);

        // Progressive halving then final bilinear step — preserves thin
        // lines that a single large-ratio downsample would lose.
        // Ping-pong between two canvases so source isn't cleared mid-step.
        if (!this._halfCanvas) {
          this._halfCanvas = document.createElement('canvas');
          this._halfCtx = this._halfCanvas.getContext('2d');
        }
        const cvs = [this._scratchCanvas, this._halfCanvas];
        const ctxs = [this._scratchCtx, this._halfCtx];
        let cw = sw, ch = sh, srcCv = this._glCanvas2d, step = 0;
        while (cw > dw * 2 || ch > dh * 2) {
          const nw = Math.max(dw, Math.ceil(cw / 2));
          const nh = Math.max(dh, Math.ceil(ch / 2));
          const dst = cvs[step & 1];
          const dctx = ctxs[step & 1];
          dst.width = nw; dst.height = nh;
          dctx.imageSmoothingEnabled = true;
          dctx.imageSmoothingQuality = 'medium';
          dctx.drawImage(srcCv, 0, 0, nw, nh);
          srcCv = dst; cw = nw; ch = nh; step++;
        }
        // Final step to exact target size.
        const final = cvs[step & 1];
        const fctx = ctxs[step & 1];
        final.width = dw; final.height = dh;
        fctx.imageSmoothingEnabled = true;
        fctx.imageSmoothingQuality = 'medium';
        fctx.drawImage(srcCv, 0, 0, dw, dh);
        this._sendRegionPng(0, 0, final);
      }
    }

    // --- Sensor region: render to canvas → PNG, right of bench ---
    if (sensorCount > 0) {
      const regionH = H;
      this._specCanvas.width = specW;
      this._specCanvas.height = regionH;
      const ctx = this._specCtx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, specW, regionH);

      let maxVal = 1e-6;
      for (let i = 0; i < sensorBins.length; i++) {
        if (sensorBins[i] > maxVal) maxVal = sensorBins[i];
      }

      const barH = Math.max(1, Math.floor(regionH / sensorCount));
      for (let s = 0; s < sensorCount; s++) {
        const dy = s * barH;
        if (dy >= regionH) break;
        for (let x = 0; x < specW; x++) {
          const b = Math.floor(x / specW * binCount);
          const v = sensorBins[s * binCount + b] / maxVal;
          if (v < 0.01) continue;
          const wl = 380 + (b + 0.5) / binCount * 400;
          const rgb = wavelengthToRGB(wl);
          const r = Math.round(rgb[0] * Math.min(1, v) * 255);
          const g = Math.round(rgb[1] * Math.min(1, v) * 255);
          const bl = Math.round(rgb[2] * Math.min(1, v) * 255);
          ctx.fillStyle = `rgb(${r},${g},${bl})`;
          ctx.fillRect(x, dy, 1, barH);
        }
      }
      this._sendRegionPng(benchRenderedW, 0, this._specCanvas);
    }
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
