#!/usr/bin/env node
// Minimal Push 2/3 display helper. Finds the Push via USB, claims the
// display interface (0), and either shows a built-in hello frame or
// accepts 16-bit RGB frames over a WebSocket from the browser.
//
// Usage:
//   cd tools && npm install && node push-display.js [--port 9100]
//
// Or started automatically by serve.js with --push-display.
//
// Protocol (Push 2 spec, believed identical for Push 3):
//   - Bulk OUT on EP 0x01, 512-byte packets
//   - 16-byte frame header: FF CC AA 88 00...
//   - 160 lines × 4 packets per line = 640 packets
//   - Each line: 1920 bytes pixel data (960 px × 2 bytes RGB565) + 128 filler
//   - Every 512-byte buffer XOR'd with repeating 0xFFE7F3E7

import usb from 'usb';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const PUSH_VENDOR  = 0x2982;
const PUSH2_PRODUCT = 0x1967;
const PUSH3_PRODUCT = 0x1969;
const DISPLAY_EP    = 0x01;
const DISPLAY_IFACE = 0;
const WIDTH = 960, HEIGHT = 160;
const LINE_BYTES = WIDTH * 2;        // 1920
const LINE_FILLER = 128;
const PACKET_SIZE = 512;
const PACKETS_PER_LINE = (LINE_BYTES + LINE_FILLER) / PACKET_SIZE; // 4
const FRAME_HEADER = new Uint8Array([
  0xFF, 0xCC, 0xAA, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
]);

// XOR mask applied to every 512-byte buffer before sending.
const XOR_PATTERN = new Uint8Array(512);
{
  const p = [0xE7, 0xF3, 0xE7, 0xFF];
  for (let i = 0; i < 512; i++) XOR_PATTERN[i] = p[i % 4];
}

function xorBuf(buf) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= XOR_PATTERN[i % 512];
}

// RGB 0-255 → RGB565 little-endian.
function rgb565(r, g, b) {
  const v = ((r >> 3) & 0x1F) | (((g >> 2) & 0x3F) << 5) | (((b >> 3) & 0x1F) << 11);
  return [v & 0xFF, (v >> 8) & 0xFF];
}

// Load and nearest-neighbour scale a PNG to fit within (maxW, maxH).
// Returns { width, height, data } where data is RGBA Uint8Array.
function loadPng(path, maxW, maxH) {
  try {
    const raw = readFileSync(path);
    const png = PNG.sync.read(raw);
    const scale = Math.min(maxW / png.width, maxH / png.height, 1);
    const w = Math.round(png.width * scale);
    const h = Math.round(png.height * scale);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.floor(y / scale);
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(x / scale);
        const si = (sy * png.width + sx) * 4;
        const di = (y * w + x) * 4;
        out[di] = png.data[si]; out[di+1] = png.data[si+1];
        out[di+2] = png.data[si+2]; out[di+3] = png.data[si+3];
      }
    }
    return { width: w, height: h, data: out };
  } catch { return null; }
}

// Build a hello frame: spectral gradient background + chromavox logo +
// "CHROMAVOX" text.
function buildHelloFrame() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const buf = new Uint8Array(HEIGHT * (LINE_BYTES + LINE_FILLER));

  // Spectral gradient background.
  for (let y = 0; y < HEIGHT; y++) {
    const off = y * (LINE_BYTES + LINE_FILLER);
    for (let x = 0; x < WIDTH; x++) {
      const hue = (x / WIDTH) * 360;
      const brightness = 0.08 + 0.06 * Math.sin(y / HEIGHT * Math.PI);
      const [r, g, b] = hslToRgb(hue, 0.7, brightness);
      const [lo, hi] = rgb565(r, g, b);
      buf[off + x * 2] = lo;
      buf[off + x * 2 + 1] = hi;
    }
  }

  // Logo image — scaled to fit the display height, placed left of center.
  const logo = loadPng(resolve(__dirname, '../docs/images/chromavox-sm.png'), WIDTH * 0.4, HEIGHT);
  if (logo) {
    const lx = 10;
    const ly = Math.floor((HEIGHT - logo.height) / 2);
    for (let y = 0; y < logo.height; y++) {
      for (let x = 0; x < logo.width; x++) {
        const si = (y * logo.width + x) * 4;
        const a = logo.data[si + 3] / 255;
        if (a < 0.1) continue;
        const px = lx + x, py = ly + y;
        if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;
        const r = Math.round(logo.data[si] * a);
        const g = Math.round(logo.data[si+1] * a);
        const b = Math.round(logo.data[si+2] * a);
        const [lo, hi] = rgb565(r, g, b);
        const off = py * (LINE_BYTES + LINE_FILLER) + px * 2;
        buf[off] = lo; buf[off + 1] = hi;
      }
    }
  }
  // Crude 5x7 pixel font for "CHROMAVOX" centered on the display.
  const text = 'CHROMAVOX';
  const CHARS = {
    C: [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E],
    H: [0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
    R: [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
    O: [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
    M: [0x11,0x1B,0x15,0x15,0x11,0x11,0x11],
    A: [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],
    V: [0x11,0x11,0x11,0x11,0x0A,0x0A,0x04],
    X: [0x11,0x0A,0x04,0x04,0x04,0x0A,0x11],
  };
  const charW = 5, charH = 7, scale = 3, gap = 2;
  const totalW = text.length * (charW * scale + gap) - gap;
  const sx = Math.floor((WIDTH - totalW) / 2);
  const sy = Math.floor((HEIGHT - charH * scale) / 2);
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = CHARS[text[ci]];
    if (!glyph) continue;
    const ox = sx + ci * (charW * scale + gap);
    for (let row = 0; row < charH; row++) {
      for (let col = 0; col < charW; col++) {
        if (!(glyph[row] & (1 << (charW - 1 - col)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = ox + col * scale + dx;
            const py = sy + row * scale + dy;
            if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;
            const off = py * (LINE_BYTES + LINE_FILLER) + px * 2;
            buf[off] = 0xFF; buf[off + 1] = 0xFF; // white
          }
        }
      }
    }
  }
  return buf;
}

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

// --- USB ---

let usbDevice = null, usbEndpoint = null;

function findPush() {
  let dev = usb.findByIds(PUSH_VENDOR, PUSH3_PRODUCT);
  if (!dev) dev = usb.findByIds(PUSH_VENDOR, PUSH2_PRODUCT);
  return dev;
}

function openPush() {
  const dev = findPush();
  if (!dev) { console.log('push-display: no Push found'); return false; }
  try {
    dev.open();
  } catch (err) {
    console.log('push-display: cannot open device:', err.message);
    console.log('  try: sudo chmod 666 /dev/bus/usb/' +
      String(dev.busNumber).padStart(3, '0') + '/' +
      String(dev.deviceAddress).padStart(3, '0'));
    return false;
  }
  const iface = dev.interface(DISPLAY_IFACE);
  if (iface.isKernelDriverActive()) {
    try { iface.detachKernelDriver(); } catch {}
  }
  try {
    iface.claim();
  } catch (err) {
    console.log('push-display: cannot claim interface 0:', err.message);
    return false;
  }
  usbDevice = dev;
  // Get the OUT endpoint (direction bit 7 = 0). endpoint() returns
  // InEndpoint or OutEndpoint depending on the address.
  usbEndpoint = iface.endpoint(DISPLAY_EP);
  if (!usbEndpoint || usbEndpoint.direction !== 'out') {
    console.log('push-display: EP 1 OUT not found, endpoints:', iface.endpoints.map(e => e.address.toString(16)));
    return false;
  }
  const name = dev.deviceDescriptor.idProduct === PUSH3_PRODUCT ? 'Push 3' : 'Push 2';
  console.log(`push-display: opened ${name} (${PUSH_VENDOR.toString(16)}:${dev.deviceDescriptor.idProduct.toString(16)})`);
  return true;
}

function transferOut(buf) {
  return new Promise((resolve, reject) => {
    usbEndpoint.transfer(buf, err => err ? reject(err) : resolve());
  });
}

async function sendFrame(pixelBuf) {
  if (!usbEndpoint) return;
  // Send header as a separate transfer.
  await transferOut(Buffer.from(FRAME_HEADER));
  // Send each 512-byte packet individually, XOR'd.
  const pkt = Buffer.alloc(PACKET_SIZE);
  for (let y = 0; y < HEIGHT; y++) {
    const lineOff = y * (LINE_BYTES + LINE_FILLER);
    for (let p = 0; p < PACKETS_PER_LINE; p++) {
      const srcOff = lineOff + p * PACKET_SIZE;
      for (let i = 0; i < PACKET_SIZE; i++) {
        pkt[i] = (pixelBuf[srcOff + i] || 0) ^ XOR_PATTERN[i];
      }
      await transferOut(Buffer.from(pkt));
    }
  }
}

// --- Compositing ---

// The base frame (hello screen) is built once. Region updates from the
// browser are composited onto a working copy immediately when received.
// The refresh loop restores the base and re-applies all regions each tick
// so the display stays current.
let baseFrame = null;
let compositeFrame = null;
let compositeDirty = false;

// Store ALL current regions so the refresh loop can re-apply them after
// restoring the base. Keyed by "x,y" so the same region overwrites.
const regionMap = new Map();

function applyAllRegions() {
  if (!compositeFrame || !baseFrame) return;
  compositeFrame.set(baseFrame);
  const STRIDE = LINE_BYTES + LINE_FILLER;
  for (const { x, y, w, h, pixels } of regionMap.values()) {
    for (let row = 0; row < h && y + row < HEIGHT; row++) {
      for (let col = 0; col < w && x + col < WIDTH; col++) {
        const srcOff = (row * w + col) * 2;
        const dstOff = (y + row) * STRIDE + (x + col) * 2;
        compositeFrame[dstOff] = pixels[srcOff];
        compositeFrame[dstOff + 1] = pixels[srcOff + 1];
      }
    }
  }
}

let _msgCount = 0, _regionCount = 0, _fullCount = 0, _lastLog = 0, _firstRegion = true;

// PNG signature starts at byte 4 (after our 4-byte x,y header).
const PNG_SIG = [0x89, 0x50, 0x4E, 0x47];

function handleBinaryMessage(payload) {
  _msgCount++;
  const FULL_FRAME_SIZE = HEIGHT * (LINE_BYTES + LINE_FILLER);
  if (payload.length === FULL_FRAME_SIZE) {
    _fullCount++;
    setFrame(new Uint8Array(payload)).catch(() => {});
  } else if (payload.length > 4 &&
             payload[4] === PNG_SIG[0] && payload[5] === PNG_SIG[1] &&
             payload[6] === PNG_SIG[2] && payload[7] === PNG_SIG[3]) {
    // PNG region: 4-byte header (x, y as uint16 LE) + PNG data.
    const x = payload[0] | (payload[1] << 8);
    const y = payload[2] | (payload[3] << 8);
    try {
      const png = PNG.sync.read(Buffer.from(payload.subarray(4)));
      const w = png.width, h = png.height;
      // Convert RGBA → RGB565 for the Push display.
      const pixels = new Uint8Array(w * h * 2);
      for (let i = 0, j = 0; i < png.data.length; i += 4, j += 2) {
        const r = png.data[i], g = png.data[i+1], b = png.data[i+2];
        const c = ((r >> 3) & 0x1F) | (((g >> 2) & 0x3F) << 5) | (((b >> 3) & 0x1F) << 11);
        pixels[j] = c & 0xFF;
        pixels[j+1] = (c >> 8) & 0xFF;
      }
      _regionCount++;
      if (_firstRegion) { console.log(`push-display: first region ${w}x${h} at (${x},${y}), ${payload.length} bytes (png)`); _firstRegion = false; }
      regionMap.set(`${x},${y}`, { x, y, w, h, pixels });
      compositeDirty = true;
    } catch (err) {
      console.log('push-display: PNG decode error:', err.message);
    }
  } else if (payload.length > 8) {
    // Legacy raw RGB565 region: 8-byte header (x, y, w, h) + pixel data.
    const x = payload[0] | (payload[1] << 8);
    const y = payload[2] | (payload[3] << 8);
    const w = payload[4] | (payload[5] << 8);
    const h = payload[6] | (payload[7] << 8);
    const expectedSize = 8 + w * h * 2;
    if (payload.length >= expectedSize) {
      _regionCount++;
      regionMap.set(`${x},${y}`, { x, y, w, h, pixels: new Uint8Array(payload.subarray(8, expectedSize)) });
      compositeDirty = true;
    }
  }
  const now = Date.now();
  if (now - _lastLog > 5000) {
    console.log(`push-display: ${_msgCount} msgs (${_regionCount} regions, ${_fullCount} full) in last 5s`);
    _msgCount = 0; _regionCount = 0; _fullCount = 0;
    _lastLog = now;
  }
}

// --- WebSocket server (uses `ws` package) ---

import { WebSocketServer } from 'ws';

const WS_PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '9100', 10);

function startWsServer() {
  const wss = new WebSocketServer({ port: WS_PORT });
  wss.on('listening', () => {
    console.log(`push-display: ws://localhost:${WS_PORT}/`);
  });
  wss.on('connection', ws => {
    console.log('push-display: browser connected');
    ws.on('message', (data, isBinary) => {
      if (isBinary) handleBinaryMessage(data);
    });
    ws.on('close', () => console.log('push-display: browser disconnected'));
    ws.on('error', err => console.log('push-display: ws error:', err.message));
  });
}

// --- Main ---

let refreshTimer = null;
let sending = false;

async function refreshLoop() {
  if (sending || !compositeFrame || !usbEndpoint) return;
  if (compositeDirty && baseFrame) {
    applyAllRegions();
    compositeDirty = false;
  }
  sending = true;
  try { await sendFrame(compositeFrame); } catch {}
  sending = false;
}

async function setFrame(buf) {
  // Full frame replaces everything.
  baseFrame = new Uint8Array(buf);
  compositeFrame = new Uint8Array(buf);
  regionMap.clear();
  compositeDirty = false;
  if (sending) return;
  sending = true;
  try { await sendFrame(compositeFrame); } catch {}
  sending = false;
}

async function main() {
  const ok = openPush();
  if (ok) {
    console.log('push-display: sending hello frame');
    await setFrame(buildHelloFrame());
    // Resend at ~30fps to keep the display alive and apply region updates.
    refreshTimer = setInterval(refreshLoop, 33);
  }
  startWsServer();
}

main().catch(err => { console.error('push-display:', err.message); process.exit(1); });
