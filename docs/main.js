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
    document.getElementById(id).style.visibility = on ? 'visible' : 'hidden';
  }
}
document.getElementById('synth-independent').addEventListener('change', () => {
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

const helpDialog = document.getElementById('help-dialog');
document.getElementById('help-toggle').addEventListener('click', () => helpDialog.showModal());
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());

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
    synth.setMode('chromatic');
  }
  synth.setBase(parseFloat(nextBase));

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
  synth.setBase(parseFloat(e.target.value));
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
  if (dirty) {
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

function updateSensorReadout() {
  const host = document.getElementById('sensor-readout');
  const bars = host.children;
  if (bars.length !== scene.sensorCount) return;
  const binCount = tracer.binCount;
  // Normalise: find max across all bins for consistent scaling, fallback 1.
  let maxVal = 1e-6;
  for (let i = 0; i < tracer.sensorBins.length; i++) {
    if (tracer.sensorBins[i] > maxVal) maxVal = tracer.sensorBins[i];
  }
  for (let s = 0; s < scene.sensorCount; s++) {
    const c = bars[s].querySelector('canvas');
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    const wlMin = 380, wlMax = 780;
    for (let b = 0; b < binCount; b++) {
      const v = tracer.sensorBins[s * binCount + b] / maxVal;
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
