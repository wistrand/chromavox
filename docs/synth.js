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

const WORKLET_SRC = `
class ChromavoxSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.bins = null;
    this.binCount = 64;
    this.peak = 1e-6;
    this.sensorCount = 0;
    this.partials = 1;
    this.carrier = 'sine'; // 'sine' | 'noise'
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'bins') {
        this.bins = d.bins;
      } else if (d.type === 'rebuild') {
        this._rebuild(d.freqs, d.binCount, d.sensorCount);
      } else if (d.type === 'partials') {
        this.partials = d.value;
        if (this.sensorCount > 0) this._rebuildPartials();
      } else if (d.type === 'carrier') {
        this.carrier = d.value;
      }
    };
  }
  _rebuild(freqs, binCount, sensorCount) {
    this.binCount = binCount;
    this.sensorCount = sensorCount;
    this._freqs = freqs;
    this._rebuildPartials();
  }
  _rebuildPartials() {
    this.voices = [];
    const nyq = sampleRate / 2;
    const freqs = this._freqs;
    if (!freqs) return;
    for (let i = 0; i < this.sensorCount; i++) {
      const f = freqs[i];
      const phases = [];
      const gains = [];
      const targetGains = [];
      for (let k = 1; k <= this.partials; k++) {
        if (f * k >= nyq) break;
        phases.push(0);
        gains.push(0);
        targetGains.push(0);
      }
      // Bandpass IIR state for noise carrier (2-pole resonator).
      // Q chosen for moderate bandwidth; coefficients computed in process().
      this.voices.push({ freq: f, phases, gains, targetGains, bp1: 0, bp2: 0 });
    }
    this.peak = 1e-6;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0] || this.voices.length === 0) return true;
    const buf = out[0];
    const len = buf.length;
    const bins = this.bins;
    const K = this.partials;
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
    const smooth = 1 - Math.exp(-1 / (0.06 * sampleRate));
    const isNoise = this.carrier === 'noise';
    for (let i = 0; i < len; i++) buf[i] = 0;
    for (let s = 0; s < this.voices.length; s++) {
      const v = this.voices[s];
      // Overall voice gain = sum of partial target gains (for noise mode).
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      if (!anyActive) { v.bp1 = 0; v.bp2 = 0; continue; }

      if (isNoise) {
        // Bandpass-filtered white noise carrier. 2-pole resonator:
        //   y[n] = x[n] - r²·y[n-2] + 2r·cos(w)·y[n-1]
        // where w = 2π·freq/sr, r controls bandwidth (closer to 1 = narrower).
        // r scales with frequency so low voices get wider bands (less
        // resonant buildup) and high voices stay tonal. Amplitude
        // normalized by sqrt(freq/200) so low voices don't dominate.
        const w = twoPi * v.freq * invSr;
        const r = Math.min(0.999, 0.993 + 0.005 * Math.min(1, v.freq / 2000));
        const c1 = 2 * r * Math.cos(w);
        const c2 = -(r * r);
        const ampScale = 0.12 / Math.max(0.3, Math.sqrt(v.freq / 200));
        // Use first partial's gain for overall amplitude.
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        let y1 = v.bp1, y2 = v.bp2;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          const noise = Math.random() * 2 - 1;
          const y0 = noise + c1 * y1 + c2 * y2;
          y2 = y1; y1 = y0;
          buf[i] += y0 * voiceGain * ampScale;
        }
        v.bp1 = y1; v.bp2 = y2;
        v.gains[0] = voiceGain;
      } else {
        // Sine / harmonic carrier.
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

  setPartials(n) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'partials', value: n });
  }

  setCarrier(mode) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'carrier', value: mode });
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
    if (this.active) this.rebuild(this.count);
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
