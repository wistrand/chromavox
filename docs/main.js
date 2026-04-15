// Entry: wire scene, tracer, renderer, UI; run the frame loop.

import { createScene } from './scene.js';
import { Tracer } from './raytracer.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { wavelengthToRGB } from './spectrum.js';
import { MicModulator, micBands } from './mic.js';
import { SensorSynth } from './synth.js';

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
const ui = new UI(scene, canvas, markDirty);
ui.rebuildSensorReadout();

const synthBtn = document.getElementById('synth-toggle');
synthBtn.addEventListener('click', () => {
  if (!synth.active) {
    const mode = document.getElementById('mic-mode').value;
    synth.setBase(parseFloat(document.getElementById('mic-base').value));
    synth.enable(scene.sensorCount, mode);
    synthBtn.textContent = 'Audio out: on';
    synthBtn.classList.add('active');
  } else {
    synth.disable();
    synthBtn.textContent = 'Audio out: off';
    synthBtn.classList.remove('active');
  }
});

document.getElementById('mic-mode').addEventListener('change', e => {
  synth.setMode(e.target.value);
});

document.getElementById('mic-source').addEventListener('change', async e => {
  // Pick a reasonable chromatic base for each debug source so its main
  // content lands inside the ladder. Microphone and noises keep C3.
  const baseBySource = {
    'sine':      '440',
    'harmonics': '220',
    'mic':       '130.81',
    'white':     '130.81',
    'pink':      '130.81',
  };
  const nextBase = baseBySource[e.target.value];
  if (nextBase) document.getElementById('mic-base').value = nextBase;
  synth.setBase(parseFloat(nextBase));

  if (!mic.active) return;
  mic.disable();
  try {
    await mic.enable(e.target.value);
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
      await mic.enable(src);
      micBtn.textContent = 'Audio in: on';
      micBtn.classList.add('active');
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
  renderer.resize();
  Object.assign(scene.bench, renderer.benchSize());
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
      const baseHz = parseFloat(document.getElementById('mic-base').value);
      scene.emitter.micLevels = micBands(mic, scene.emitter.count, micMode, baseHz);
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
