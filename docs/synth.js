// Additive sensor synth via AudioWorklet. Each sensor is a voice at a
// log- or scale-spaced pitch; timbre comes from the sensor's wavelength
// spectrum grouped into harmonic partials.
//
// The worklet runs a single AudioWorkletProcessor that synthesises all
// voices in one `process()` callback — no per-oscillator nodes, no
// setTargetAtTime storms. The main thread posts sensorBins each frame
// via MessagePort; the worklet reads the latest snapshot on each audio
// block. Voices with zero energy are skipped (free voice stealing).

import { scaleFreq } from './spectrum.js';

const PARTIALS = 6;

const WORKLET_SRC = `
class ChromavoxSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];     // [{freq, phases[], gains[], targetGains[]}]
    this.bins = null;     // latest sensorBins snapshot (Float32Array)
    this.binCount = 64;
    this.peak = 1e-6;
    this.sensorCount = 0;
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'bins') {
        this.bins = d.bins;
      } else if (d.type === 'rebuild') {
        this._rebuild(d.freqs, d.binCount, d.sensorCount);
      }
    };
  }
  _rebuild(freqs, binCount, sensorCount) {
    this.binCount = binCount;
    this.sensorCount = sensorCount;
    this.voices = [];
    const nyq = sampleRate / 2;
    for (let i = 0; i < sensorCount; i++) {
      const f = freqs[i];
      const phases = [];
      const gains = [];
      const targetGains = [];
      for (let k = 1; k <= ${PARTIALS}; k++) {
        if (f * k >= nyq) break;
        phases.push(0);
        gains.push(0);
        targetGains.push(0);
      }
      this.voices.push({ freq: f, phases, gains, targetGains });
    }
    this.peak = 1e-6;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0] || this.voices.length === 0) return true;
    const buf = out[0];
    const len = buf.length;
    const bins = this.bins;
    const K = ${PARTIALS};
    const bc = this.binCount;
    const sc = this.sensorCount;
    // Compute target gains from latest bins snapshot.
    if (bins && bins.length >= sc * bc) {
      let maxP = 1e-6;
      for (let s = 0; s < sc; s++) {
        const v = this.voices[s];
        const nk = v.targetGains.length;
        for (let k = 0; k < nk; k++) {
          const b0 = (k * bc / K) | 0;
          const b1 = ((k + 1) * bc / K) | 0;
          let sum = 0;
          for (let b = b0; b < b1; b++) sum += bins[s * bc + b];
          const avg = sum / Math.max(1, b1 - b0);
          if (avg > maxP) maxP = avg;
          v.targetGains[k] = avg;
        }
      }
      this.peak = Math.max(maxP, this.peak * 0.94);
      const norm = 1 / (Math.sqrt(sc) * this.peak);
      for (let s = 0; s < sc; s++) {
        const v = this.voices[s];
        for (let k = 0; k < v.targetGains.length; k++) {
          v.targetGains[k] = Math.pow(Math.max(0, v.targetGains[k]) * norm, 1.3);
        }
      }
    }
    // Synthesise.
    const twoPi = 2 * Math.PI;
    const invSr = 1 / sampleRate;
    // Gain smoothing per sample — roughly 60ms time constant at 48kHz.
    const smooth = 1 - Math.exp(-1 / (0.06 * sampleRate));
    for (let i = 0; i < len; i++) buf[i] = 0;
    for (let s = 0; s < this.voices.length; s++) {
      const v = this.voices[s];
      // Skip silent voices.
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      if (!anyActive) continue;
      for (let i = 0; i < len; i++) {
        let sample = 0;
        for (let k = 0; k < v.phases.length; k++) {
          v.gains[k] += (v.targetGains[k] - v.gains[k]) * smooth;
          if (v.gains[k] < 1e-6 && v.targetGains[k] < 1e-6) continue;
          sample += Math.sin(v.phases[k]) * v.gains[k];
          v.phases[k] += twoPi * v.freq * (k + 1) * invSr;
          if (v.phases[k] > twoPi) v.phases[k] -= twoPi;
        }
        buf[i] += sample;
      }
    }
    return true;
  }
}
registerProcessor('chromavox-synth', ChromavoxSynth);
`;

export class SensorSynth {
  constructor() {
    this.active = false;
    this.ctx = null;
    this.workletNode = null;
    this.master = null;
    this.count = 0;
    this.volume = 0.25;
    this.mode = 'log';
    this.baseHz = 130.81;
    this.sinkId = '';
    this.stepSemi = 1;
    // Slow-decaying peak hold for amplitude normalization (used by the
    // spectrum readout; worklet has its own internal copy).
    this.peak = 1e-6;
  }

  setStep(stepSemi) {
    if (this.stepSemi === stepSemi) return;
    this.stepSemi = stepSemi;
    if (this.active && this.mode !== 'log') this.rebuild(this.count);
  }

  async setSinkId(id) {
    this.sinkId = id || '';
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      try { await this.ctx.setSinkId(this.sinkId); } catch (err) {
        console.warn('setSinkId failed:', err);
      }
    }
  }

  setBase(hz) {
    if (!hz || this.baseHz === hz) return;
    this.baseHz = hz;
    if (this.active && this.mode === 'chromatic') this.rebuild(this.count);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  async enable(sensorCount, mode = 'log') {
    if (this.active) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume ?? 0.25;
    this.master.connect(this.ctx.destination);
    this.mode = mode;
    if (this.sinkId && typeof this.ctx.setSinkId === 'function') {
      this.ctx.setSinkId(this.sinkId).catch(err => console.warn('setSinkId:', err));
    }
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.workletNode = new AudioWorkletNode(this.ctx, 'chromavox-synth', {
      outputChannelCount: [1],
    });
    this.workletNode.connect(this.master);
    this.rebuild(sensorCount);
    this.active = true;
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.active) this.rebuild(this.count);
  }

  rebuild(sensorCount) {
    if (!this.ctx || !this.workletNode) return;
    const loHz = 110, hiHz = 1800;
    const baseHz = this.baseHz ?? 130.81;
    const stepDeg = this.stepSemi ?? 1;
    const scaleName = (this.mode && this.mode !== 'log') ? this.mode : 'chromatic';
    const freqs = new Float32Array(sensorCount);
    for (let i = 0; i < sensorCount; i++) {
      if (this.mode !== 'log') {
        freqs[i] = scaleFreq(baseHz, scaleName, i, stepDeg);
      } else {
        const t = sensorCount > 1 ? i / (sensorCount - 1) : 0;
        freqs[i] = loHz * Math.pow(hiHz / loHz, t);
      }
    }
    this.workletNode.port.postMessage({
      type: 'rebuild',
      freqs,
      binCount: 64,
      sensorCount,
    });
    this.count = sensorCount;
  }

  update(sensorBins, binCount, sensorCount) {
    if (!this.active) return;
    if (sensorCount !== this.count) this.rebuild(sensorCount);
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'bins',
      bins: sensorBins,
    });
  }

  disable() {
    if (!this.active) return;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.master?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.active = false;
    this.count = 0;
  }
}
