// Entry: wire scene, tracer, renderer, UI; run the frame loop.

import { createScene } from './scene.js';
import { Tracer } from './raytracer.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { wavelengthToRGB } from './spectrum.js';
import { MicModulator, micBands } from './mic.js';
import { SensorSynth } from './synth.js';
import { scaleFreq } from './spectrum.js';

const canvas = document.getElementById('gl');
const renderer = new Renderer(canvas);
const scene = createScene();
// Sync bench size to canvas aspect so content fills the viewport.
Object.assign(scene.bench, renderer.benchSize());
const tracer = new Tracer();

let dirty = true;
const markDirty = () => { dirty = true; };
let lastFrameTime = performance.now() / 1000;

const mic = new MicModulator();
const synth = new SensorSynth();

// Keyboard source tracks its own octave; the chromatic ladder's base note
// follows that octave so new key presses map to the ladder's bucket 0.
function currentBaseHz() {
  if (mic.active && mic.source === 'keyboard') {
    return 16.352 * Math.pow(2, mic.keyboardOctave);
  }
  return parseFloat(document.getElementById('mic-base').value);
}
let lastBaseHz = null;

function syncBaseSelect(hz) {
  const sel = document.getElementById('mic-base');
  let best = null, bestDist = Infinity;
  for (const opt of sel.options) {
    const d = Math.abs(parseFloat(opt.value) - hz);
    if (d < bestDist) { best = opt; bestDist = d; }
  }
  if (best && sel.value !== best.value) sel.value = best.value;
}
const ui = new UI(scene, canvas, markDirty);
ui.rebuildSensorReadout();

const distortToggle = document.getElementById('distort-toggle');
renderer.distortEnabled = distortToggle.checked;
distortToggle.addEventListener('change', () => {
  renderer.distortEnabled = distortToggle.checked;
  markDirty();
});

const synthBtn = document.getElementById('synth-toggle');
synthBtn.addEventListener('click', () => {
  if (!synth.active) {
    synth.setBase(synthBase());
    synth.setStep(synthStep());
    synth.enable(scene.sensorCount, synthMode());
    synthBtn.textContent = 'Audio out: on';
    synthBtn.classList.add('active');
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
  rebuildEmitterLabels();
});

document.getElementById('chromatic-span').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) || 1;
  document.getElementById('chromatic-span-val').textContent = v;
  if (!synthIndep()) synth.setStep(v);
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
    div.style.top = `${((i + 0.5) / n) * 100}%`;
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
    div.style.top = `${((i + 0.5) / n) * 100}%`;
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
    scene.emitter.micLevels = null;
    scene.emitter.wlPerSource = null;
    markDirty();
  }
});

document.getElementById('synth-device').addEventListener('change', e => {
  synth.setSinkId(e.target.value || '');
});

populateMicDevices();
populateSynthDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  populateMicDevices();
  populateSynthDevices();
});

function syncMicDeviceVisibility() {
  const row = document.getElementById('mic-device-row');
  const isMic = document.getElementById('mic-source').value === 'mic';
  row.style.visibility = isMic ? 'visible' : 'hidden';
}
syncMicDeviceVisibility();

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
  };
  const nextBase = baseBySource[e.target.value];
  if (nextBase) document.getElementById('mic-base').value = nextBase;
  if (e.target.value === 'keyboard') {
    const modeSel = document.getElementById('mic-mode');
    modeSel.value = 'chromatic';
    if (!synthIndep()) synth.setMode('chromatic');
  }
  if (!synthIndep()) synth.setBase(parseFloat(nextBase));

  if (!mic.active) return;
  mic.disable();
  try {
    const dev = document.getElementById('mic-device').value || null;
    await mic.enable(e.target.value, dev);
  } catch (err) {
    alert('Audio input: ' + err.message);
    micBtn.textContent = 'Audio in: off';
    micBtn.classList.remove('active');
    scene.emitter.micLevels = null;
    scene.emitter.wlPerSource = null;
    markDirty();
  }
});

document.getElementById('mic-base').addEventListener('change', e => {
  if (!synthIndep()) synth.setBase(parseFloat(e.target.value));
  rebuildEmitterLabels();
});

const volSlider = document.getElementById('synth-vol');
const volLabel = document.getElementById('synth-vol-val');
synth.setVolume(parseInt(volSlider.value, 10) / 100);
volSlider.addEventListener('input', () => {
  synth.setVolume(parseInt(volSlider.value, 10) / 100);
  volLabel.textContent = volSlider.value;
});

const micBtn = document.getElementById('mic-toggle');
micBtn.addEventListener('click', async () => {
  if (!mic.active) {
    try {
      const src = document.getElementById('mic-source').value;
      const dev = document.getElementById('mic-device').value || null;
      await mic.enable(src, dev);
      micBtn.textContent = 'Audio in: on';
      micBtn.classList.add('active');
      populateMicDevices();
      populateSynthDevices();
    } catch (err) {
      alert('Microphone: ' + err.message);
    }
  } else {
    mic.disable();
    scene.emitter.micLevels = null;
    scene.emitter.wlPerSource = null;
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
      scene.emitter.micLevels = micBands(mic, scene.emitter.count, micMode, baseHz, stepSemi);
      if (baseHz !== lastBaseHz) {
        if (!synthIndep()) synth.setBase(baseHz);
        if (mic.source === 'keyboard') syncBaseSelect(baseHz);
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
        scene.emitter.wlPerSource = { min, max };
      } else {
        scene.emitter.wlPerSource = null;
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

  // Phase 3 simulation: particles inside delay elements advance each
  // frame, so we must re-trace whenever the scene is dirty *or* any
  // pool holds in-flight particles. Outside those conditions RAF idles.
  const particlesInFlight = tracer.activeParticleCount() > 0;
  if (dirty || particlesInFlight) {
    dirty = false;
    tracer.trace(scene);
    renderer.draw(scene, tracer);
    updateSensorReadout();
  }

  if (synth.active) {
    synth.update(tracer.sensorBins, tracer.binCount, scene.sensorCount);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// (A) Gaussian-blur scratch for spatial smoothing of sensor spectrums.
let _blurBuf = new Float32Array(0);
// (C) Temporal IIR display buffer — lerps toward sensorBins each frame.
let _displayBins = new Float32Array(0);
// (D) Slow-decaying peak normalization — prevents the global scale from
// snapping on single-frame spikes.
let _peakMax = 1e-6;

function updateSensorReadout() {
  const host = document.getElementById('sensor-readout');
  const bars = host.children;
  if (bars.length !== scene.sensorCount) return;
  const binCount = tracer.binCount;
  const totalBins = scene.sensorCount * binCount;

  // Resize IIR buffer if sensor layout changed.
  if (_displayBins.length !== totalBins) {
    _displayBins = new Float32Array(totalBins);
    _peakMax = 1e-6;
  }
  if (_blurBuf.length < binCount) _blurBuf = new Float32Array(binCount);

  // (C) Temporal IIR: displayBins lerps toward sensorBins.
  const IIR = 0.3;
  for (let i = 0; i < totalBins; i++) {
    _displayBins[i] += (tracer.sensorBins[i] - _displayBins[i]) * IIR;
  }

  // (D) Slow-decaying peak normalization.
  let curMax = 1e-6;
  for (let i = 0; i < totalBins; i++) {
    if (_displayBins[i] > curMax) curMax = _displayBins[i];
  }
  _peakMax = Math.max(curMax, _peakMax * 0.95);

  for (let s = 0; s < scene.sensorCount; s++) {
    const c = bars[s].querySelector('canvas');
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);

    // (A) Gaussian blur across bins: [0.25, 0.5, 0.25] kernel.
    const base = s * binCount;
    const blur = _blurBuf;
    for (let b = 0; b < binCount; b++) {
      const prev = b > 0 ? _displayBins[base + b - 1] : _displayBins[base + b];
      const cur  = _displayBins[base + b];
      const next = b < binCount - 1 ? _displayBins[base + b + 1] : cur;
      blur[b] = prev * 0.25 + cur * 0.5 + next * 0.25;
    }

    const wlMin = 380, wlMax = 780;
    for (let b = 0; b < binCount; b++) {
      const v = blur[b] / _peakMax;
      if (v <= 0) continue;
      const wl = wlMin + (b + 0.5) / binCount * (wlMax - wlMin);
      const rgb = wavelengthToRGB(wl);
      const a = Math.min(1, v);
      ctx.fillStyle = `rgba(${(rgb[0] * 255)|0},${(rgb[1] * 255)|0},${(rgb[2] * 255)|0},${a})`;
      const x = (b / binCount) * c.width;
      const w = c.width / binCount + 1;
      ctx.fillRect(x, 0, w, c.height);
    }
  }
}
