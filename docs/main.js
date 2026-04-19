// Entry: wire scene, tracer, renderer, UI; run the frame loop.

import { createScene, serializeScene, deserializeScene } from './scene.js';
import { Tracer } from './raytracer.js';
import { GPUTracer } from './gpu-tracer.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { wavelengthToRGB } from './spectrum.js';
import { MicModulator, micBands } from './mic.js';
import { SensorSynth } from './synth.js';
import { PushController } from './push.js';
import { scaleFreq } from './spectrum.js';

const STORAGE_KEY = 'chromavox-scene';

const canvas = document.getElementById('gl');
const renderer = new Renderer(canvas);
let scene;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  scene = saved ? deserializeScene(saved) : createScene();
} catch {
  scene = createScene();
}
// Sync bench size to canvas aspect so content fills the viewport.
Object.assign(scene.bench, renderer.benchSize());
const forceCPU = new URLSearchParams(location.search).has('cpu');
const gpuTracer = forceCPU ? null : new GPUTracer(renderer.gl);
const cpuTracer = new Tracer();
let tracer = (gpuTracer && gpuTracer._ready) ? gpuTracer : cpuTracer;

// Auto-switch: use CPU tracer when delay elements are present (GPU
// tracer doesn't support particle simulation / secondary rays).
const _tracerLabel = document.getElementById('tracer-indicator');
function pickTracer() {
  const hasDelay = scene.elements.some(el =>
    (el.delayK ?? 0) > 0.0003 || el.material === 'slowGlass');
  const want = (!gpuTracer || !gpuTracer._ready || hasDelay) ? cpuTracer : gpuTracer;
  if (want !== tracer) {
    tracer = want;
    tracer.resetPersistence();
    dirty = true;
  }
  _tracerLabel.textContent = `Tracer: ${tracer === gpuTracer ? 'GPU' : 'CPU'}`;
}

let dirty = true;

const UI_STORAGE_KEY = 'chromavox-ui';
const UI_CONTROL_IDS = [
  'mic-source', 'mic-device', 'midi-device', 'mic-mode', 'mic-base',
  'chromatic-span', 'mic-smoothing', 'bucket-color', 'synth-independent',
  'synth-mode', 'synth-base', 'synth-span', 'synth-vol', 'synth-carrier', 'synth-partials',
  'acid-res', 'acid-env', 'synth-device',
  'emitter-count', 'sensor-count', 'sensor-sync', 'sensor-factor',
  'midi-gain', 'sim-rate', 'distort-toggle',
];
function saveUiState() {
  const state = {};
  for (const id of UI_CONTROL_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    state[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state)); } catch {}
}
function restoreUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    for (const [id, val] of Object.entries(state)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = val;
      else el.value = val;
    }
    // Fire input + change events so dependent state syncs (span
    // visibility, independent scale, distort, sim-rate labels, etc.).
    // Range inputs need 'input' to trigger scene updates; 'change'
    // fires endEdit / label rebuilds.
    for (const id of UI_CONTROL_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'range') el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    }
  } catch {}
}

const markDirty = () => {
  dirty = true;
  try { localStorage.setItem(STORAGE_KEY, serializeScene(scene)); } catch {}
  saveUiState();
};
function resetDisplay() {
  renderer.resetReadout();
  tracer.resetPersistence();
}
let lastFrameTime = performance.now() / 1000;

const mic = new MicModulator();
const synth = new SensorSynth();
const push = new PushController();

// Push encoder CC → selected element property control.
// CC 71-78 map to: rotation, spin, x, y, size/w, size/h, delayK, hue.
push.onCC = (cc, val) => {
  if (!ui.selected && scene.elements.length > 0) {
    ui.select(scene.elements[0]);
    // select() triggers onChange which may leave history clean.
    // Return here — the selection itself is the action for this CC
    // event. The next CC will apply the delta.
    return;
  }
  if (!ui.selected) return;
  const delta = val < 64 ? -(64 - val) : (val - 64);
  if (delta === 0) return;
  const el = ui.selected;
  ui.beginEdit();
  // Encoder order: x, y, rotation, spin, hue, delay, size/w, h/radius.
  switch (cc) {
    case 71: el.x += Math.sign(delta) * 0.5; break;
    case 72: el.y += Math.sign(delta) * 0.5; break;
    case 73: el.rot += Math.sign(delta) * 0.005; break;
    case 74: el.spin = (el.spin || 0) - Math.sign(delta) * 0.4 * Math.PI / 180; break;
    case 75: {
      const cur = el.color || '#ffffff';
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cur);
      if (m) {
        let [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
        const angle = Math.sign(delta) * 0.5 * Math.PI / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const nr = Math.round(Math.max(0, Math.min(255, r * cos - g * sin)));
        const ng = Math.round(Math.max(0, Math.min(255, r * sin + g * cos)));
        el.color = '#' + nr.toString(16).padStart(2, '0') + ng.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
      }
      break;
    }
    case 76:
      el.delayK = Math.max(0, (el.delayK || 0) + Math.sign(delta) * 0.000005);
      break;
    case 77:
      if (el.size !== undefined) el.size = Math.max(20, el.size + Math.sign(delta) * 0.3);
      else if (el.w !== undefined) el.w = Math.max(10, el.w + Math.sign(delta) * 0.3);
      break;
    case 78:
      if (el.h !== undefined) el.h = Math.max(10, el.h + Math.sign(delta) * 0.3);
      else if (el.radius !== undefined) el.radius = Math.max(20, el.radius + Math.sign(delta) * 0.5);
      break;
  }
  ui.renderPropPanel();
  ui.endEdit();
  markDirty();
};
// Route mic CC events: transport buttons handled here, encoders to Push.
mic.onCC = (cc, val) => {
  // Play button (CC 85) toggles audio out. Only on press (val > 0).
  if (cc === 85 && val > 0) { synthBtn.click(); return; }
  // + button (CC 32) adds a new element (same as the Add button).
  if (cc === 32 && val > 0) { document.getElementById('add-btn').click(); return; }
  // Volume encoder (CC 79) adjusts synth master volume.
  if (cc === 79) {
    const dir = val >= 64 ? -1 : 1;
    const volSlider = document.getElementById('synth-vol');
    const nv = Math.max(0, Math.min(100, parseInt(volSlider.value, 10) + dir * 2));
    volSlider.value = nv;
    synth.setVolume(nv / 100);
    document.getElementById('synth-vol-val').textContent = nv;
    return;
  }
  // Large selection wheel (CC 70). Cycles through scene elements.
  if (cc === 70 && scene.elements.length > 0) {
    const dir = val >= 64 ? 1 : -1;
    if (dir === 0) return;
    const cur = ui.selected ? scene.elements.indexOf(ui.selected) : -1;
    const n = scene.elements.length;
    const next = ((cur + dir) % n + n) % n;
    ui.select(scene.elements[next]);
    return;
  }
  push.handleCC(cc, val);
};

// Attach/detach Push after MIDI enable/disable. Called from all the
// mic.enable / mic.disable sites so the wiring stays in one place.
function attachPush() {
  if (mic.source === 'midi' && mic._midiAccess && mic._midiInput) {
    push.attach(mic._midiAccess, mic._midiInput);
  }
}
function detachPush() { push.detach(); }

function currentBaseHz() {
  return parseFloat(document.getElementById('mic-base').value);
}
let lastBaseHz = null;

// Push current mode / base / span to the keyboard source so its voices
// match the input scale.  Called on mode/base/span change and on
// keyboard source selection.
function syncKeyboardScale() {
  const mode = document.getElementById('mic-mode').value;
  const base = currentBaseHz();
  const step = parseInt(document.getElementById('chromatic-span').value, 10) || 1;
  const scaleName = mode === 'log' ? 'chromatic' : mode;
  mic.setKeyboardScale(scaleName, base, step);
  push.setScale(scaleName);
}

function syncBaseSelect(hz) {
  const sel = document.getElementById('mic-base');
  let best = null, bestDist = Infinity;
  for (const opt of sel.options) {
    const d = Math.abs(parseFloat(opt.value) - hz);
    if (d < bestDist) { best = opt; bestDist = d; }
  }
  if (best && sel.value !== best.value) sel.value = best.value;
}
const ui = new UI(scene, canvas, markDirty, resetDisplay);
restoreUiState();
ui.syncControls();
ui.rebuildSensorReadout();
syncKeyboardScale();

const distortToggle = document.getElementById('distort-toggle');
renderer.distortEnabled = distortToggle.checked;
distortToggle.addEventListener('change', () => {
  renderer.distortEnabled = distortToggle.checked;
  markDirty();
});

const synthBtn = document.getElementById('synth-toggle');
synthBtn.addEventListener('click', async () => {
  if (!synth.active) {
    try {
      synth.setBase(synthBase());
      synth.setStep(synthStep());
      await synth.enable(scene.sensorCount, synthMode());
      _applyInitialPartials();
      synthBtn.textContent = 'Audio out: on';
      synthBtn.classList.add('active');
    } catch (err) {
      console.error('Audio out failed:', err);
      synthBtn.textContent = `Audio out: ${err.message || err}`;
      setTimeout(() => { synthBtn.textContent = 'Audio out: off'; }, 5000);
    }
  } else {
    synth.disable();
    synthBtn.textContent = 'Audio out: off';
    synthBtn.classList.remove('active');
  }
});

function syncSpanVisibility() {
  const on = document.getElementById('mic-mode').value !== 'log';
  document.getElementById('chromatic-span-row').style.visibility = on ? 'visible' : 'hidden';
}
syncSpanVisibility();

// Synth scale can either follow the mic side (default) or run independently
// from its own Mode/Base/Span/Scale controls. Read state via these helpers.
const synthIndep = () => document.getElementById('synth-independent').checked;
const synthMode  = () => synthIndep()
  ? document.getElementById('synth-mode').value
  : document.getElementById('mic-mode').value;
const synthBase  = () => synthIndep()
  ? parseFloat(document.getElementById('synth-base').value)
  : currentBaseHz();
const synthStep  = () => synthIndep()
  ? (parseInt(document.getElementById('synth-span').value, 10) || 1)
  : (parseInt(document.getElementById('chromatic-span').value, 10) || 1);
function pushSynthScale() {
  synth.setMode(synthMode());
  synth.setBase(synthBase());
  synth.setStep(synthStep());
}

document.getElementById('mic-mode').addEventListener('change', e => {
  if (!synthIndep()) synth.setMode(e.target.value);
  syncSpanVisibility();
  syncKeyboardScale();
  rebuildEmitterLabels();
});

document.getElementById('chromatic-span').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) || 1;
  document.getElementById('chromatic-span-val').textContent = v;
  if (!synthIndep()) synth.setStep(v);
  syncKeyboardScale();
  rebuildEmitterLabels();
});

// Independent synth scale toggle — show/hide synth-mode/base/span rows and
// push the active set of values into the synth.
function syncSynthIndepVisibility() {
  const on = synthIndep();
  for (const id of ['synth-mode-row', 'synth-base-row', 'synth-span-row']) {
    const row = document.getElementById(id);
    row.classList.toggle('row-disabled', !on);
    row.querySelectorAll('input, select').forEach(el => { el.disabled = !on; });
  }
}
document.getElementById('synth-independent').addEventListener('change', e => {
  // When turning on, copy current mic-side values into the synth controls
  // so the audible output doesn't jump until the user explicitly tweaks
  // them. Both dropdowns share option values so direct assignment works.
  if (e.target.checked) {
    document.getElementById('synth-mode').value = document.getElementById('mic-mode').value;
    document.getElementById('synth-base').value = document.getElementById('mic-base').value;
    const span = document.getElementById('chromatic-span').value;
    document.getElementById('synth-span').value = span;
    document.getElementById('synth-span-val').textContent = span;
  }
  syncSynthIndepVisibility();
  pushSynthScale();
});
document.getElementById('synth-mode').addEventListener('change', () => {
  if (synthIndep()) pushSynthScale();
});
document.getElementById('synth-base').addEventListener('change', () => {
  if (synthIndep()) pushSynthScale();
});
document.getElementById('synth-span').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) || 1;
  document.getElementById('synth-span-val').textContent = v;
  if (synthIndep()) pushSynthScale();
});
syncSynthIndepVisibility();

// Sim rate: slider 0..100 → log-mapped 0.05× … 4×, default 1× at 50.
// Scales the particle-advance dt in the tracer. >1× drains delay glass
// faster; <1× makes it more viscous.
const simRateSlider = document.getElementById('sim-rate');
const simRateLabel = document.getElementById('sim-rate-val');
const SR_MIN = Math.log(0.05), SR_MAX = Math.log(4);
function applySimRate() {
  const t = parseInt(simRateSlider.value, 10) / 100;
  const rate = Math.exp(SR_MIN + t * (SR_MAX - SR_MIN));
  tracer.simRate = rate;
  simRateLabel.textContent = rate.toFixed(2) + '×';
}
applySimRate();
simRateSlider.addEventListener('input', applySimRate);

const smoothingSlider = document.getElementById('mic-smoothing');
const smoothingLabel = document.getElementById('mic-smoothing-val');
const applySmoothing = () => {
  const v = parseInt(smoothingSlider.value, 10) / 100;
  smoothingLabel.textContent = v.toFixed(2);
  mic.setSmoothing(v);
};
applySmoothing();
smoothingSlider.addEventListener('input', applySmoothing);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function freqToNote(hz) {
  const m = Math.round(12 * Math.log2(hz / 440)) + 69;
  const oct = Math.floor(m / 12) - 1;
  return NOTE_NAMES[((m % 12) + 12) % 12] + oct;
}
function rebuildEmitterLabels() {
  const host = document.getElementById('emitter-labels');
  if (!host) return;
  host.innerHTML = '';
  const n = scene.emitter.count;
  const mode = document.getElementById('mic-mode').value;
  const base = currentBaseHz();
  const stepSemi = parseInt(document.getElementById('chromatic-span').value, 10) || 1;
  for (let i = 0; i < n; i++) {
    let txt;
    if (mode !== 'log') {
      txt = freqToNote(scaleFreq(base, mode, i, stepSemi));
    } else {
      const lo = 80, hi = 6000;
      const t = n > 1 ? i / (n - 1) : 0;
      const hz = Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
      txt = hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
    }
    const div = document.createElement('div');
    div.className = 'emitter-label';
    div.textContent = txt;
    div.style.top = `${((n - 1 - i + 0.5) / n) * 100}%`;
    host.appendChild(div);
  }
}
rebuildEmitterLabels();
['mic-mode', 'mic-base', 'mic-source', 'chromatic-span', 'emitter-count']
  .forEach(id => document.getElementById(id).addEventListener('input', rebuildEmitterLabels));
['mic-mode', 'mic-base', 'mic-source']
  .forEach(id => document.getElementById(id).addEventListener('change', rebuildEmitterLabels));

function rebuildSensorLabels() {
  const host = document.getElementById('sensor-labels');
  if (!host) return;
  host.innerHTML = '';
  const n = scene.sensorCount;
  const mode = synthMode();
  const base = synthBase();
  const stepDeg = synthStep();
  for (let i = 0; i < n; i++) {
    let txt;
    if (mode !== 'log') {
      txt = freqToNote(scaleFreq(base, mode, i, stepDeg));
    } else {
      const lo = 80, hi = 6000;
      const t = n > 1 ? i / (n - 1) : 0;
      const hz = Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
      txt = hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
    }
    const div = document.createElement('div');
    div.className = 'sensor-label';
    div.textContent = txt;
    div.style.top = `${((n - 1 - i + 0.5) / n) * 100}%`;
    host.appendChild(div);
  }
}
rebuildSensorLabels();
// Sensor labels track synth-side params plus sensor count. Anything that
// changes either side should refresh them.
['sensor-count', 'synth-mode', 'synth-base', 'synth-span', 'synth-independent',
 'mic-mode', 'mic-base', 'mic-source', 'chromatic-span']
  .forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', rebuildSensorLabels);
    el.addEventListener('change', rebuildSensorLabels);
  });

const helpDialog = document.getElementById('help-dialog');
document.getElementById('help-toggle').addEventListener('click', () => helpDialog.showModal());
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());

// Toolbar options dropdowns (Audio in / Audio out). Position is fixed so
// they escape the toolbar's overflow-x clipping rect.
function bindOptionsMenu(toggleId, menuId) {
  const toggle = document.getElementById(toggleId);
  const menu = document.getElementById(menuId);
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('open')) {
      menu.classList.remove('open');
      return;
    }
    // Close any other options menus first.
    document.querySelectorAll('.options-menu.open').forEach(m => m.classList.remove('open'));
    const r = toggle.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(4, r.right - 280)}px`;
    menu.classList.add('open');
  });
  menu.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', e => {
    if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== toggle) {
      menu.classList.remove('open');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) menu.classList.remove('open');
  });
}
bindOptionsMenu('mic-options', 'mic-menu');
bindOptionsMenu('synth-options', 'synth-menu');

window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); synthBtn.click(); }
  if (e.key === 'a' || e.key === 'A') { e.preventDefault(); micBtn.click(); }
  if (e.key === 'h' || e.key === 'H' || e.key === '?') {
    e.preventDefault();
    if (helpDialog.open) helpDialog.close(); else helpDialog.showModal();
  }
});

async function populateDevices(selectId, kind, fallbackName) {
  const sel = document.getElementById(selectId);
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const cur = sel.value;
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'default';
  sel.appendChild(def);
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    let n = 1;
    for (const d of devs) {
      if (d.kind !== kind) continue;
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${fallbackName} ${n++}`;
      sel.appendChild(o);
    }
  } catch {}
  sel.value = cur;
}
const populateMicDevices    = () => populateDevices('mic-device',   'audioinput',  'input');
const populateSynthDevices  = () => populateDevices('synth-device', 'audiooutput', 'output');

document.getElementById('mic-device').addEventListener('change', async () => {
  if (!mic.active || mic.source !== 'mic') return;
  mic.disable();
  try {
    const dev = document.getElementById('mic-device').value || null;
    await mic.enable('mic', dev);
  } catch (err) {
    alert('Microphone: ' + err.message);
    micBtn.textContent = 'Audio in: off';
    micBtn.classList.remove('active');
    scene.runtime.micLevels = null;
    scene.runtime.wlPerSource = null;
    markDirty();
  }
});

document.getElementById('synth-device').addEventListener('change', e => {
  synth.setSinkId(e.target.value || '');
});

populateMicDevices();
populateSynthDevices();
populateMidiDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  populateMicDevices();
  populateSynthDevices();
});

function syncMicDeviceVisibility() {
  const src = document.getElementById('mic-source').value;
  document.getElementById('mic-device-row').style.display = src === 'mic' ? '' : 'none';
  document.getElementById('midi-device-row').style.display = src === 'midi' ? '' : 'none';
  document.getElementById('midi-gain-row').style.display = src === 'midi' ? '' : 'none';
  document.getElementById('midi-debug-row').style.display = src === 'midi' ? '' : 'none';
}
syncMicDeviceVisibility();

document.getElementById('midi-gain').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) / 100;
  document.getElementById('midi-gain-val').textContent = v.toFixed(2);
  mic.midiGain = v;
});

// --- Touch input: pointer events on stage → emitter levels ---
// Listen on #stage (not canvas) so touches in the letterbox black
// bars also register — the Y coordinate maps to emitters regardless
// of horizontal position.
{
  const stage = document.getElementById('stage');
  const _touchPointers = new Map(); // pointerId → emitterIdx
  const TOUCH_ZONE_PX = 60; // bench pixels from left wall
  function touchEmitterIdx(e) {
    // Map client coords to bench coords via the canvas rect.
    const rect = canvas.getBoundingClientRect();
    const benchX = (e.clientX - rect.left) / rect.width * scene.bench.w;
    const benchY = (e.clientY - rect.top) / rect.height * scene.bench.h;
    // Only accept touches near the left wall (emitter ticks) or in
    // the black bar to the left of the canvas (benchX < 0).
    if (benchX > TOUCH_ZONE_PX) return -1;
    const nSrc = scene.emitter.count;
    const stripH = scene.bench.h / nSrc;
    const idx = nSrc - 1 - Math.floor(benchY / stripH);
    return Math.max(0, Math.min(nSrc - 1, idx));
  }
  stage.addEventListener('contextmenu', e => {
    if (mic.source === 'touch') e.preventDefault();
  });
  stage.addEventListener('pointerdown', e => {
    if (mic.source !== 'touch') return;
    const idx = touchEmitterIdx(e);
    if (idx < 0) return; // outside touch zone — let UI handle it
    e.preventDefault();  // prevent browser pan/drag gesture
    e.stopPropagation(); // prevent UI emitter toggle / element select
    _touchPointers.set(e.pointerId, idx);
    mic.setTouchLevel(idx, 1);
    dirty = true;
  });
  stage.addEventListener('pointermove', e => {
    if (mic.source !== 'touch') return;
    if (!_touchPointers.has(e.pointerId)) return;
    e.stopPropagation(); // keep note pointer away from UI drag/pinch
    const oldIdx = _touchPointers.get(e.pointerId);
    const newIdx = touchEmitterIdx(e);
    if (newIdx < 0) return; // moved out of touch zone — keep current
    if (newIdx !== oldIdx) {
      mic.setTouchLevel(oldIdx, 0);
      mic.setTouchLevel(newIdx, 1);
      _touchPointers.set(e.pointerId, newIdx);
      dirty = true;
    }
  });
  const touchUp = e => {
    if (mic.source !== 'touch') return;
    if (!_touchPointers.has(e.pointerId)) return;
    e.stopPropagation(); // prevent UI from processing note-pointer release
    const idx = _touchPointers.get(e.pointerId);
    mic.setTouchLevel(idx, 0);
    _touchPointers.delete(e.pointerId);
    dirty = true;
  };
  stage.addEventListener('pointerup', touchUp);
  stage.addEventListener('pointercancel', touchUp);
}

// MIDI device picker.
async function populateMidiDevices() {
  const sel = document.getElementById('midi-device');
  if (!navigator.requestMIDIAccess) return;
  const cur = sel.value;
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'first available';
  sel.appendChild(def);
  try {
    const access = await navigator.requestMIDIAccess();
    for (const [id, inp] of access.inputs) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = inp.name || id;
      sel.appendChild(o);
    }
  } catch {}
  // Restore saved selection. On first load the dropdown was empty when
  // restoreUiState ran, so the saved value was silently ignored.
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || '{}');
    if (saved['midi-device']) sel.value = saved['midi-device'];
    else sel.value = cur;
  } catch { sel.value = cur; }
}

document.getElementById('midi-device').addEventListener('change', async () => {
  if (!mic.active || mic.source !== 'midi') return;
  detachPush();
  mic.disable();
  try {
    await mic.enable('midi', document.getElementById('midi-device').value || null);
    populateMidiDevices();
    attachPush();
  } catch (err) {
    alert('MIDI: ' + err.message);
    micBtn.textContent = 'Audio in: off';
    micBtn.classList.remove('active');
    scene.runtime.micLevels = null;
    markDirty();
  }
});

document.getElementById('mic-source').addEventListener('change', async e => {
  syncMicDeviceVisibility();
  // Pick a reasonable chromatic base for each debug source so its main
  // content lands inside the ladder. Microphone and noises keep C3.
  const baseBySource = {
    'sine':      '440',
    'harmonics': '220',
    'mic':       '130.81',
    'white':     '130.81',
    'pink':      '130.81',
    'keyboard':  '261.63',
    'midi':      '130.81',
  };
  const nextBase = baseBySource[e.target.value];
  if (nextBase) document.getElementById('mic-base').value = nextBase;
  if (e.target.value === 'keyboard') {
    syncKeyboardScale();
  }
  if (!synthIndep()) synth.setBase(parseFloat(nextBase));

  if (e.target.value === 'midi') populateMidiDevices();

  if (!mic.active) return;
  detachPush();
  mic.disable();
  try {
    const dev = e.target.value === 'midi'
      ? (document.getElementById('midi-device').value || null)
      : (document.getElementById('mic-device').value || null);
    await mic.enable(e.target.value, dev);
    if (e.target.value === 'midi') attachPush();
  } catch (err) {
    alert('Audio input: ' + err.message);
    micBtn.textContent = 'Audio in: off';
    micBtn.classList.remove('active');
    scene.runtime.micLevels = null;
    scene.runtime.wlPerSource = null;
    markDirty();
  }
});

document.getElementById('mic-base').addEventListener('change', e => {
  if (!synthIndep()) synth.setBase(parseFloat(e.target.value));
  syncKeyboardScale();
  rebuildEmitterLabels();
});

const volSlider = document.getElementById('synth-vol');
const volLabel = document.getElementById('synth-vol-val');
synth.setVolume(parseInt(volSlider.value, 10) / 100);
volSlider.addEventListener('input', () => {
  synth.setVolume(parseInt(volSlider.value, 10) / 100);
  volLabel.textContent = volSlider.value;
});

const partialsSlider = document.getElementById('synth-partials');
const partialsLabel = document.getElementById('synth-partials-val');
partialsSlider.addEventListener('input', () => {
  const v = parseInt(partialsSlider.value, 10) || 1;
  partialsLabel.textContent = v;
  synth.setPartials(v);
});

const carrierSel = document.getElementById('synth-carrier');
const partialsRow = document.getElementById('partials-row');
const acidResRow = document.getElementById('acid-res-row');
const acidEnvRow = document.getElementById('acid-env-row');
const acidResSlider = document.getElementById('acid-res');
const acidEnvSlider = document.getElementById('acid-env');
function syncCarrierVisibility() {
  const c = carrierSel.value;
  partialsRow.style.display = c === 'sine' ? '' : 'none';
  acidResRow.style.display = c === 'acid' ? '' : 'none';
  acidEnvRow.style.display = c === 'acid' ? '' : 'none';
}
carrierSel.addEventListener('change', () => { synth.setCarrier(carrierSel.value); syncCarrierVisibility(); });
acidResSlider.addEventListener('input', () => {
  const v = parseInt(acidResSlider.value, 10) / 100;
  document.getElementById('acid-res-val').textContent = v.toFixed(2);
  synth.setAcidRes(v);
});
acidEnvSlider.addEventListener('input', () => {
  const v = parseInt(acidEnvSlider.value, 10) / 100;
  document.getElementById('acid-env-val').textContent = v.toFixed(2);
  synth.setAcidEnv(v);
});
syncCarrierVisibility();

const _applyInitialPartials = () => {
  synth.setPartials(parseInt(partialsSlider.value, 10) || 1);
  synth.setCarrier(carrierSel.value);
  synth.setAcidRes(parseInt(acidResSlider.value, 10) / 100);
  synth.setAcidEnv(parseInt(acidEnvSlider.value, 10) / 100);
  syncCarrierVisibility();
};

const micBtn = document.getElementById('mic-toggle');
micBtn.addEventListener('click', async () => {
  if (!mic.active) {
    try {
      const src = document.getElementById('mic-source').value;
      const dev = src === 'midi'
        ? (document.getElementById('midi-device').value || null)
        : (document.getElementById('mic-device').value || null);
      await mic.enable(src, dev);
      if (src === 'midi') { populateMidiDevices(); attachPush(); }
      micBtn.textContent = 'Audio in: on';
      micBtn.classList.add('active');
      populateMicDevices();
      populateSynthDevices();
    } catch (err) {
      alert('Microphone: ' + err.message);
    }
  } else {
    detachPush();
    mic.disable();
    scene.runtime.micLevels = null;
    scene.runtime.wlPerSource = null;
    micBtn.textContent = 'Audio in: off';
    micBtn.classList.remove('active');
    markDirty();
  }
});

window.addEventListener('resize', () => {
  // Bench is canonical / letterboxed; no element rescaling on resize.
  renderer.resize();
  markDirty();
});

// --- Floating stats window ---
{
  const statsWin = document.getElementById('stats-window');
  const statsToggle = document.getElementById('stats-toggle');
  const statsClose = statsWin.querySelector('.fw-close');
  const statsContent = document.getElementById('stats-content');
  const titlebar = statsWin.querySelector('.fw-titlebar');

  // Position near top-right on first show.
  let positioned = false;
  function showStats() {
    if (!positioned) {
      statsWin.style.top = '64px';
      statsWin.style.right = '12px';
      statsWin.style.left = 'auto';
      positioned = true;
    }
    statsWin.hidden = false;
    statsToggle.checked = true;
  }
  function hideStats() {
    statsWin.hidden = true;
    statsToggle.checked = false;
  }
  statsToggle.addEventListener('change', () => {
    if (statsToggle.checked) showStats(); else hideStats();
  });
  statsClose.addEventListener('click', hideStats);

  // Dragging.
  let dragOff = null;
  titlebar.addEventListener('pointerdown', e => {
    if (e.target.closest('.fw-close')) return;
    e.preventDefault();
    titlebar.setPointerCapture(e.pointerId);
    const r = statsWin.getBoundingClientRect();
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    statsWin.style.right = 'auto';
  });
  titlebar.addEventListener('pointermove', e => {
    if (!dragOff) return;
    statsWin.style.left = (e.clientX - dragOff.x) + 'px';
    statsWin.style.top  = (e.clientY - dragOff.y) + 'px';
  });
  titlebar.addEventListener('pointerup', () => { dragOff = null; });
  titlebar.addEventListener('lostpointercapture', () => { dragOff = null; });

  // Update stats text each frame (only when visible).
  let _fpsFrames = 0, _fpsTime = performance.now(), _fpsVal = 0;
  window._updateStats = function() {
    // FPS: update every 500ms
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsTime >= 500) {
      _fpsVal = _fpsFrames / ((now - _fpsTime) / 1000);
      _fpsFrames = 0;
      _fpsTime = now;
    }
    if (statsWin.hidden) return;
    const segs = tracer.segmentCount;
    const parts = tracer.activeParticleCount();
    const pools = tracer._pools ? tracer._pools.size : 0;
    const els = scene.elements.length;
    const sensors = scene.sensorCount;
    const sources = scene.emitter.count;
    const rays = scene.emitter.raysPerSource;
    const spinning = scene.elements.filter(e => e.spin).length;
    statsContent.textContent =
      `FPS:        ${_fpsVal.toFixed(0)}\n` +
      `Elements:   ${els}\n` +
      `Sources:    ${sources}\n` +
      `Sensors:    ${sensors}\n` +
      `Rays/src:   ${rays}\n` +
      `Segments:   ${segs}\n` +
      `Particles:  ${parts}\n` +
      `Pools:      ${pools}\n` +
      `Spinning:   ${spinning}`;
  };
}

// --- Mic spectrum debug window ---
{
  const specWin = document.getElementById('mic-spectrum-window');
  const specToggle = document.getElementById('mic-spectrum-toggle');
  const specClose = specWin.querySelector('.fw-close');
  const specCanvas = document.getElementById('mic-spectrum-canvas');
  const specCtx = specCanvas.getContext('2d');
  const titlebar = specWin.querySelector('.fw-titlebar');

  let positioned = false;
  function showSpec() {
    if (!positioned) {
      specWin.style.top = '130px';
      specWin.style.right = '12px';
      specWin.style.left = 'auto';
      positioned = true;
    }
    specWin.hidden = false;
    specToggle.checked = true;
  }
  function hideSpec() { specWin.hidden = true; specToggle.checked = false; }
  specToggle.addEventListener('change', () => { specToggle.checked ? showSpec() : hideSpec(); });
  specClose.addEventListener('click', hideSpec);

  let dragOff = null;
  titlebar.addEventListener('pointerdown', e => {
    if (e.target.closest('.fw-close')) return;
    e.preventDefault();
    titlebar.setPointerCapture(e.pointerId);
    const r = specWin.getBoundingClientRect();
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    specWin.style.right = 'auto';
  });
  titlebar.addEventListener('pointermove', e => {
    if (!dragOff) return;
    specWin.style.left = (e.clientX - dragOff.x) + 'px';
    specWin.style.top  = (e.clientY - dragOff.y) + 'px';
  });
  titlebar.addEventListener('pointerup', () => { dragOff = null; });
  titlebar.addEventListener('lostpointercapture', () => { dragOff = null; });

  // Render raw FFT (grey) + micBands bucket levels (colored bars) on a
  // shared log-frequency axis so both align visually.
  window._updateMicSpectrum = function() {
    if (specWin.hidden || !mic.active) return;
    const W = specCanvas.width, H = specCanvas.height;
    specCtx.fillStyle = '#000';
    specCtx.fillRect(0, 0, W, H);

    const fd = mic.freqData;
    const n = scene.emitter.count;
    const micMode = document.getElementById('mic-mode').value;
    const baseHz = parseFloat(document.getElementById('mic-base').value) || 130.81;
    const step = parseInt(document.getElementById('chromatic-span').value, 10) || 1;

    // Compute the frequency range from the bucket endpoints.
    let loHz, hiHz;
    if (micMode === 'log') {
      loHz = 80; hiHz = 6000;
    } else {
      loHz = scaleFreq(baseHz, micMode, 0, step) * 0.8;
      hiHz = scaleFreq(baseHz, micMode, n, step) * 1.2;
    }
    const logLo = Math.log(Math.max(20, loHz));
    const logHi = Math.log(Math.max(loHz + 1, hiHz));
    const freqToX = hz => hz <= 0 ? -1 : (Math.log(hz) - logLo) / (logHi - logLo) * W;

    // Raw FFT on log frequency axis.
    if (fd && fd.length > 0 && mic.ctx) {
      const nyquist = mic.ctx.sampleRate / 2;
      specCtx.strokeStyle = '#555';
      specCtx.lineWidth = 1;
      specCtx.beginPath();
      let started = false;
      for (let i = 1; i < fd.length; i++) {
        const hz = (i / fd.length) * nyquist;
        if (hz < loHz * 0.5 || hz > hiHz * 1.5) continue;
        const x = freqToX(hz);
        const y = H - (fd[i] / 255) * H;
        if (!started) { specCtx.moveTo(x, y); started = true; }
        else specCtx.lineTo(x, y);
      }
      specCtx.stroke();
    }

    // Bucket bars aligned to the same log axis.
    const levels = scene.runtime.micLevels;
    if (levels) {
      for (let i = 0; i < n; i++) {
        const v = levels[i];
        if (v < 0.01) continue;
        let f0, f1;
        if (micMode === 'log') {
          f0 = Math.exp(Math.log(80) + (i / n) * (Math.log(6000) - Math.log(80)));
          f1 = Math.exp(Math.log(80) + ((i + 1) / n) * (Math.log(6000) - Math.log(80)));
        } else {
          const fc = scaleFreq(baseHz, micMode, i, step);
          const fcN = scaleFreq(baseHz, micMode, i + 1, step);
          const fcP = i > 0 ? scaleFreq(baseHz, micMode, i - 1, step) : fc * fc / fcN;
          f0 = Math.sqrt(fcP * fc);
          f1 = Math.sqrt(fc * fcN);
        }
        const x0 = Math.max(0, freqToX(f0));
        const x1 = Math.min(W, freqToX(f1));
        if (x1 <= x0) continue;
        const t = n > 1 ? i / (n - 1) : 0.5;
        const hue = 200 + t * 160;
        specCtx.fillStyle = `hsla(${hue},80%,50%,${Math.min(1, v * 1.5)})`;
        specCtx.fillRect(x0, H - v * H, x1 - x0, v * H);
      }
    }

    // Axis labels.
    specCtx.fillStyle = '#666';
    specCtx.font = '9px monospace';
    for (const hz of [100, 200, 500, 1000, 2000, 5000]) {
      if (hz < loHz * 0.9 || hz > hiHz * 1.1) continue;
      const x = freqToX(hz);
      specCtx.fillText(hz >= 1000 ? `${hz/1000}k` : `${hz}`, x + 2, H - 2);
      specCtx.fillRect(x, 0, 1, H);
    }
  };
}

// --- Synth spectrum debug window ---
{
  const specWin = document.getElementById('synth-spectrum-window');
  const specToggle = document.getElementById('synth-spectrum-toggle');
  const specClose = specWin.querySelector('.fw-close');
  const specCanvas = document.getElementById('synth-spectrum-canvas');
  const specCtx = specCanvas.getContext('2d');
  const titlebar = specWin.querySelector('.fw-titlebar');

  let positioned = false;
  function showSpec() {
    if (!positioned) {
      specWin.style.top = '270px';
      specWin.style.right = '12px';
      specWin.style.left = 'auto';
      positioned = true;
    }
    specWin.hidden = false;
    specToggle.checked = true;
  }
  function hideSpec() { specWin.hidden = true; specToggle.checked = false; }
  specToggle.addEventListener('change', () => { specToggle.checked ? showSpec() : hideSpec(); });
  specClose.addEventListener('click', hideSpec);

  let dragOff = null;
  titlebar.addEventListener('pointerdown', e => {
    if (e.target.closest('.fw-close')) return;
    e.preventDefault();
    titlebar.setPointerCapture(e.pointerId);
    const r = specWin.getBoundingClientRect();
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    specWin.style.right = 'auto';
  });
  titlebar.addEventListener('pointermove', e => {
    if (!dragOff) return;
    specWin.style.left = (e.clientX - dragOff.x) + 'px';
    specWin.style.top  = (e.clientY - dragOff.y) + 'px';
  });
  titlebar.addEventListener('pointerup', () => { dragOff = null; });
  titlebar.addEventListener('lostpointercapture', () => { dragOff = null; });

  // Render actual synth output FFT — same approach as the mic spectrum
  // but reading from synth.analyser instead of mic.analyser.
  window._updateSynthSpectrum = function() {
    if (specWin.hidden || !synth.active || !synth.analyser) return;
    const W = specCanvas.width, H = specCanvas.height;
    specCtx.fillStyle = '#000';
    specCtx.fillRect(0, 0, W, H);

    const fd = synth.freqFloat;
    if (!fd) return;
    synth.analyser.getFloatFrequencyData(fd);

    const nyquist = synth.ctx.sampleRate / 2;
    const binCount = fd.length;

    // Match mic spectrum's frequency range so both views align.
    const micMode = document.getElementById('mic-mode').value;
    const baseHz = parseFloat(document.getElementById('mic-base').value) || 130.81;
    const step = parseInt(document.getElementById('chromatic-span').value, 10) || 1;
    const n = scene.emitter.count;
    let loHz, hiHz;
    if (micMode === 'log') {
      loHz = 80; hiHz = 6000;
    } else {
      loHz = scaleFreq(baseHz, micMode, 0, step) * 0.8;
      hiHz = scaleFreq(baseHz, micMode, n, step) * 1.2;
    }
    const logLo = Math.log(Math.max(20, loHz));
    const logHi = Math.log(Math.max(loHz + 1, hiHz));
    const freqToX = hz => hz <= 0 ? -1 : (Math.log(hz) - logLo) / (logHi - logLo) * W;

    // Raw FFT curve on log frequency axis.
    const minDb = synth.analyser.minDecibels;
    const maxDb = synth.analyser.maxDecibels;
    const dbRange = maxDb - minDb;
    specCtx.strokeStyle = '#555';
    specCtx.lineWidth = 1;
    specCtx.beginPath();
    let started = false;
    for (let i = 1; i < binCount; i++) {
      const hz = (i / binCount) * nyquist;
      if (hz < loHz * 0.5 || hz > hiHz * 1.5) continue;
      const x = freqToX(hz);
      const db = Math.max(minDb, fd[i]);
      const y = H - ((db - minDb) / dbRange) * H;
      if (!started) { specCtx.moveTo(x, y); started = true; }
      else specCtx.lineTo(x, y);
    }
    specCtx.stroke();

    // Axis labels.
    specCtx.fillStyle = '#666';
    specCtx.font = '9px monospace';
    for (const hz of [100, 200, 500, 1000, 2000, 5000]) {
      if (hz < loHz * 0.9 || hz > hiHz * 1.1) continue;
      const x = freqToX(hz);
      specCtx.fillText(hz >= 1000 ? `${hz/1000}k` : `${hz}`, x + 2, H - 2);
      specCtx.fillRect(x, 0, 1, H);
    }
  };
}

// --- Synth waveform debug window ---
{
  const wfWin = document.getElementById('synth-waveform-window');
  const wfToggle = document.getElementById('synth-waveform-toggle');
  const wfClose = wfWin.querySelector('.fw-close');
  const wfCanvas = document.getElementById('synth-waveform-canvas');
  const wfCtx = wfCanvas.getContext('2d');
  const titlebar = wfWin.querySelector('.fw-titlebar');
  let wfTimeData = null;

  let positioned = false;
  function showWf() {
    if (!positioned) {
      wfWin.style.top = '410px';
      wfWin.style.right = '12px';
      wfWin.style.left = 'auto';
      positioned = true;
    }
    wfWin.hidden = false;
    wfToggle.checked = true;
  }
  function hideWf() { wfWin.hidden = true; wfToggle.checked = false; }
  wfToggle.addEventListener('change', () => { wfToggle.checked ? showWf() : hideWf(); });
  wfClose.addEventListener('click', hideWf);

  let dragOff = null;
  titlebar.addEventListener('pointerdown', e => {
    if (e.target.closest('.fw-close')) return;
    e.preventDefault();
    titlebar.setPointerCapture(e.pointerId);
    const r = wfWin.getBoundingClientRect();
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    wfWin.style.right = 'auto';
  });
  titlebar.addEventListener('pointermove', e => {
    if (!dragOff) return;
    wfWin.style.left = (e.clientX - dragOff.x) + 'px';
    wfWin.style.top  = (e.clientY - dragOff.y) + 'px';
  });
  titlebar.addEventListener('pointerup', () => { dragOff = null; });
  titlebar.addEventListener('lostpointercapture', () => { dragOff = null; });

  window._updateSynthWaveform = function() {
    if (wfWin.hidden || !synth.active || !synth.analyser) return;
    const W = wfCanvas.width, H = wfCanvas.height;
    wfCtx.fillStyle = '#000';
    wfCtx.fillRect(0, 0, W, H);

    const an = synth.analyser;
    if (!wfTimeData || wfTimeData.length !== an.fftSize) {
      wfTimeData = new Float32Array(an.fftSize);
    }
    an.getFloatTimeDomainData(wfTimeData);

    // Draw waveform centered vertically, scaled to fill height.
    const samples = wfTimeData.length;
    // Show ~2-4 periods of the lowest active voice for readable shape.
    // Display 1024 samples (~21ms at 48kHz).
    const dispLen = Math.min(1024, samples);

    wfCtx.strokeStyle = '#8cf';
    wfCtx.lineWidth = 1;
    wfCtx.beginPath();
    for (let i = 0; i < dispLen; i++) {
      const x = (i / dispLen) * W;
      const y = H / 2 - wfTimeData[i] * H * 0.45;
      if (i === 0) wfCtx.moveTo(x, y);
      else wfCtx.lineTo(x, y);
    }
    wfCtx.stroke();

    // Center line.
    wfCtx.strokeStyle = '#333';
    wfCtx.lineWidth = 1;
    wfCtx.beginPath();
    wfCtx.moveTo(0, H / 2);
    wfCtx.lineTo(W, H / 2);
    wfCtx.stroke();
  };
}

function frame() {
  if (mic.active) {
    const s = mic.sample();
    if (s) {
      // Each source maps to one audio bucket; bucket amplitude scales that
      // source's ray intensity. Optionally, each source also gets its own
      // narrow wavelength band derived from its bucket position.
      const micMode = document.getElementById('mic-mode').value;
      const baseHz = currentBaseHz();
      const stepSemi = parseInt(document.getElementById('chromatic-span').value, 10) || 1;
      // Deterministic sources (keyboard, sine, harmonics): bypass FFT and
      // set emitter levels directly from known frequencies. FFT bin
      // resolution is too coarse to separate adjacent scale degrees,
      // causing spectral leakage into neighboring buckets.
      scene.runtime.micLevels = mic.directLevels(scene.emitter.count, micMode, baseHz, stepSemi)
        || micBands(mic, scene.emitter.count, micMode, baseHz, stepSemi);
      // Touch mode: override disabled emitters so all ticks respond.
      if (mic.source === 'touch') scene.emitter.disabled.clear();
      if (baseHz !== lastBaseHz) {
        if (!synthIndep()) synth.setBase(baseHz);
        rebuildEmitterLabels();
        lastBaseHz = baseHz;
      }
      if (document.getElementById('bucket-color').checked) {
        const n = scene.emitter.count;
        const min = new Float32Array(n);
        const max = new Float32Array(n);
        const band = 12;
        for (let i = 0; i < n; i++) {
          const t = n > 1 ? i / (n - 1) : 0.5;
          const wl = 400 + t * 300;
          min[i] = Math.max(380, wl - band);
          max[i] = Math.min(780, wl + band);
        }
        scene.runtime.wlPerSource = { min, max };
      } else {
        scene.runtime.wlPerSource = null;
      }
      dirty = true;
    }
  }

  // Continuous rotation: step each spinning element's rot by spin * dt.
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastFrameTime, 0.25);
  lastFrameTime = now;
  for (const el of scene.elements) {
    if (el.spin) { el.rot += el.spin * dt; dirty = true; }
  }

  // Auto-switch GPU↔CPU tracer based on delay elements.
  pickTracer();

  // Phase 3 simulation: particles inside delay elements advance each
  // frame, so we must re-trace whenever the scene is dirty *or* any
  // pool holds in-flight particles. Outside those conditions RAF idles.
  const particlesInFlight = tracer.activeParticleCount() > 0;
  if (dirty || particlesInFlight) {
    dirty = false;
    tracer.trace(scene);
    // Push display capture hooks into the renderer between the element
    // pass and the overlay pass — gets rays + elements without ticks/lines.
    renderer.onPreOverlay = (push.output && push.displayConnected)
      ? () => push.updateDisplay(tracer.sensorBins, tracer.binCount, scene.sensorCount, canvas)
      : null;
    renderer.draw(scene, tracer);
    renderer.onPreOverlay = null;
    renderer.updateReadout(scene, tracer);
  }

  if (synth.active) {
    if (synth.raysPer !== scene.emitter.raysPerSource) {
      synth.raysPer = scene.emitter.raysPerSource;
      synth.rebuild(scene.sensorCount);
    }
    synth.update(tracer.sensorBins, tracer.binCount, scene.sensorCount);
  }

  // Push pad LED feedback (no GL dependency — runs every frame).
  if (push.output) {
    push.updateFromSensors(tracer.sensorBins, tracer.binCount, scene.sensorCount, scene.emitter, scene.runtime);
  }

  window._updateStats();
  window._updateMicSpectrum();
  window._updateSynthSpectrum();
  window._updateSynthWaveform();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

