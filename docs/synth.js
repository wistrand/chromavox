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
// Fast tanh via lookup table. 4096 entries over [-4, 4].
// Beyond ±4, tanh ≈ ±1. Linear interpolation between entries.
const _TANH_N = 4096;
const _TANH_MAX = 4;
const _TANH_TBL = new Float32Array(_TANH_N + 1);
for (let i = 0; i <= _TANH_N; i++) {
  _TANH_TBL[i] = Math.tanh(-_TANH_MAX + (2 * _TANH_MAX * i / _TANH_N));
}
function ftanh(x) {
  if (x <= -_TANH_MAX) return -1;
  if (x >= _TANH_MAX) return 1;
  const t = (x + _TANH_MAX) * (_TANH_N / (2 * _TANH_MAX));
  const i = t | 0;
  const f = t - i;
  return _TANH_TBL[i] + (_TANH_TBL[i + 1] - _TANH_TBL[i]) * f;
}

class ChromavoxSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.bins = null;
    this.binCount = 64;
    this.fullScale = 1;
    this.sensorCount = 0;
    this.partials = 1;
    this.carrier = 'sine'; // 'sine' | 'noise' | 'acid' | 'fm' | 'supersaw'
    this.fmRatio = 2.0;     // modulator/carrier frequency ratio
    this.fmDepth = 0.5;     // env amount [0, 1] → modulation index scale
    this.ssDetune = 0.3;    // supersaw detune [0, 1] → 0-50 cents spread
    this.acidRes = 0.85;    // resonance [0, 1] → feedback k
    this.acidEnv = 0.6;     // env amount [0, 1] → octaves of cutoff sweep
    this.acidCutoff = 0.5;  // base cutoff [0, 1] → 80-8000 Hz
    this.acidDecay = 0.4;   // envelope decay [0, 1] → 30ms-2s time constant
    this.acidDrive = 0.6;   // post-filter drive [0, 1] → 1-5× saturation
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'bins') {
        this.bins = d.bins;
      } else if (d.type === 'rebuild') {
        this._rebuild(d.freqs, d.binCount, d.sensorCount, d.fullScale);
      } else if (d.type === 'partials') {
        this.partials = d.value;
        if (this.sensorCount > 0) this._rebuildPartials();
      } else if (d.type === 'carrier') {
        this.carrier = d.value;
      } else if (d.type === 'fmRatio') {
        this.fmRatio = d.value;
      } else if (d.type === 'fmDepth') {
        this.fmDepth = d.value;
      } else if (d.type === 'ssDetune') {
        this.ssDetune = d.value;
      } else if (d.type === 'acidRes') {
        this.acidRes = d.value;
      } else if (d.type === 'acidEnv') {
        this.acidEnv = d.value;
      } else if (d.type === 'acidCutoff') {
        this.acidCutoff = d.value;
      } else if (d.type === 'acidDecay') {
        this.acidDecay = d.value;
      } else if (d.type === 'acidDrive') {
        this.acidDrive = d.value;
      }
    };
  }
  _rebuild(freqs, binCount, sensorCount, fullScale) {
    this.binCount = binCount;
    this.sensorCount = sensorCount;
    if (fullScale) this.fullScale = fullScale;
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
      // Bandpass IIR state for noise carrier (single 2-pole resonator).
      // Acid carrier: PolyBLEP saw phase + 3-pole TPT ladder filter state
      // + smoothed cutoff to avoid clicks from abrupt sweeps.
      this.voices.push({ freq: f, phases, gains, targetGains,
        bp1: 0, bp2: 0,
        sawPhase: 0, lp1: 0, lp2: 0, lp3: 0, smoothCutoff: 0,
        modPhase: 0,
        ssPhases: new Float32Array(7) });
    }
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
    const isNoise = this.carrier === 'noise';
    const isAcid = this.carrier === 'acid';
    const isFM = this.carrier === 'fm';
    const isSupersaw = this.carrier === 'supersaw';
    // Compute target gains from latest bins snapshot.
    // Normalize by fullScale (BASE_INTENSITY * sqrt(raysPer)) to recover
    // the 0-1 micGain scale, then apply floor + gamma. This matches the
    // mic spectrum's absolute scaling so quiet voices stay quiet.
    // Noise and acid carriers use K=1 (single band per voice).
    if (bins && bins.length >= sc * bc) {
      const fs = this.fullScale;
      const gainK = (isNoise || isAcid || isFM || isSupersaw) ? 1 : K;
      const partialFS = fs / gainK;
      const voiceScale = 1 / Math.sqrt(sc * gainK);
      for (let s = 0; s < sc; s++) {
        const v = this.voices[s];
        const nk = v.targetGains.length;
        for (let k = 0; k < nk; k++) {
          // In noise mode (gainK=1), only k=0 is meaningful — it sums
          // all bc bins for this sensor. k>0 would read past this
          // sensor's bin range into the next sensor, so zero them.
          if (k >= gainK) { v.targetGains[k] = 0; continue; }
          const b0 = (k * bc / gainK) | 0;
          const b1 = ((k + 1) * bc / gainK) | 0;
          let sum = 0;
          for (let b = b0; b < b1; b++) sum += bins[s * bc + b];
          // Normalize to 0-1 using the known full-scale deposit.
          const g = Math.min(1, sum / partialFS);
          v.targetGains[k] = g < 0.15 ? 0
            : Math.pow((g - 0.15) / 0.85, 1.5) * voiceScale / (k + 1);
        }
      }
    }
    // Synthesise.
    const twoPi = 2 * Math.PI;
    const invSr = 1 / sampleRate;
    const smooth = 1 - Math.exp(-1 / (0.06 * sampleRate));
    for (let i = 0; i < len; i++) buf[i] = 0;
    const voices = this.voices;
    const voiceCount = voices.length;
    for (let s = 0; s < voiceCount; s++) {
      const v = voices[s];
      // Overall voice gain = sum of partial target gains (for noise mode).
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      if (!anyActive) { v.bp1 = 0; v.bp2 = 0; v.lp1 = 0; v.lp2 = 0; v.lp3 = 0; v.smoothCutoff = 0; continue; }

      if (isAcid) {
        // 303-style acid carrier: PolyBLEP sawtooth → 3-pole TPT/ZDF
        // diode ladder filter with tanh feedback → drive.
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const baseFreq = v.freq;
        const dt = baseFreq * invSr;
        const acidRes = this.acidRes;
        const acidEnv = this.acidEnv;
        // Base cutoff: 80-8000 Hz log-mapped from the knob [0,1].
        const baseCutoffHz = 80 * Math.pow(100, this.acidCutoff);
        // Decay: per-sample smoothing constant. Maps [0,1] → 30ms-2s.
        // Lower values = longer decay = slower squelch = more 303.
        const decayMs = 0.03 + this.acidDecay * 1.97; // 30ms to 2s
        const envSmooth = 1 - Math.exp(-1 / (decayMs * sampleRate));
        // Drive: 1× (clean) to 5× (screaming).
        const driveAmt = 1 + this.acidDrive * 4;
        // Feedback coefficient: k=0 → no resonance, k≈4.5 → self-osc.
        const k = acidRes * 4.5;
        let phase = v.sawPhase;
        let s1 = v.lp1, s2 = v.lp2, s3 = v.lp3;
        let sCutoff = v.smoothCutoff;
        // Precompute constants for the inner loop.
        const envScale = acidEnv * 5;
        const ln2 = 0.6931471805599453;
        const piInvSr = Math.PI * invSr;
        const cutoffCeil = sampleRate * 0.45;
        // Compute tan(g) once per block from the current smoothed cutoff.
        // The cutoff changes slowly (smoothed by envSmooth per sample),
        // so recomputing tan every sample is wasteful. Update once per
        // block; the per-sample error is inaudible at 128-sample blocks.
        let g = Math.tan(piInvSr * sCutoff);
        let g1 = g / (1 + g);
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          // PolyBLEP sawtooth
          phase += dt;
          let saw = 2 * phase - 1;
          if (phase >= 1) { phase -= 1; saw = 2 * phase - 1; }
          const t1 = phase / dt;
          if (t1 < 1) { saw -= t1 + t1 - t1 * t1 - 1; }
          const t2 = (1 - phase) / dt;
          if (t2 < 1) { saw += t2 * t2 - t2 - t2 + 1; }
          // Target cutoff: base + envelope sweep from sensor energy.
          // exp(x * ln2) is faster than pow(2, x).
          const targetCutoff = Math.min(cutoffCeil,
            baseCutoffHz * Math.exp(voiceGain * envScale * ln2));
          // Smooth cutoff with the decay time constant.
          sCutoff += (targetCutoff - sCutoff) * envSmooth;
          // Recompute filter coefficient at midpoint of block.
          if (i === (len >> 1)) { g = Math.tan(piInvSr * sCutoff); g1 = g / (1 + g); }
          // Input with resonance feedback.
          const u = saw * 1.5 - k * ftanh(s3);
          // 3 cascaded one-poles (18 dB/oct diode ladder)
          const v1 = (u - s1) * g1; s1 += 2 * v1;
          const v2 = (s1 - s2) * g1; s2 += 2 * v2;
          const v3 = (s2 - s3) * g1; s3 += 2 * v3;
          // Post-filter drive.
          const driven = ftanh(s3 * driveAmt);
          buf[i] += driven * voiceGain;
        }
        v.sawPhase = phase;
        v.lp1 = s1; v.lp2 = s2; v.lp3 = s3;
        v.smoothCutoff = sCutoff;
        v.gains[0] = voiceGain;
      } else if (isFM) {
        // FM synthesis carrier. Modulator sine modulates carrier sine.
        // Sensor energy (voiceGain) drives modulation index — low energy
        // = clean sine, high energy = bright metallic harmonics.
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const cFreq = v.freq;
        const mFreq = cFreq * this.fmRatio;
        const maxIndex = this.fmDepth * 8; // mod index 0-8
        const cInc = twoPi * cFreq * invSr;
        const mInc = twoPi * mFreq * invSr;
        let cPhase = v.phases.length > 0 ? v.phases[0] : 0;
        let mPhase = v.modPhase;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          const modIndex = voiceGain * maxIndex;
          const mod = Math.sin(mPhase) * modIndex;
          const sample = Math.sin(cPhase + mod) * voiceGain;
          buf[i] += sample;
          cPhase += cInc;
          mPhase += mInc;
          if (cPhase > twoPi) cPhase -= twoPi;
          if (mPhase > twoPi) mPhase -= twoPi;
        }
        if (v.phases.length > 0) v.phases[0] = cPhase;
        v.modPhase = mPhase;
        v.gains[0] = voiceGain;
      } else if (isSupersaw) {
        // Supersaw: 7 detuned saws (center + 3 pairs symmetrically spread).
        // Detune in cents, spread across pairs: ±1/3, ±2/3, ±1 of max.
        // PolyBLEP on each saw for antialiasing. Normalized by 1/7.
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const baseFreq = v.freq;
        const maxCents = this.ssDetune * 50; // 0-50 cents
        const detuneRatios = [
          1,
          Math.pow(2, maxCents / 3 / 1200),
          Math.pow(2, -maxCents / 3 / 1200),
          Math.pow(2, maxCents * 2 / 3 / 1200),
          Math.pow(2, -maxCents * 2 / 3 / 1200),
          Math.pow(2, maxCents / 1200),
          Math.pow(2, -maxCents / 1200),
        ];
        const dts = new Float32Array(7);
        for (let j = 0; j < 7; j++) dts[j] = baseFreq * detuneRatios[j] * invSr;
        const ph = v.ssPhases;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          let sum = 0;
          for (let j = 0; j < 7; j++) {
            ph[j] += dts[j];
            let saw = 2 * ph[j] - 1;
            if (ph[j] >= 1) { ph[j] -= 1; saw = 2 * ph[j] - 1; }
            // PolyBLEP correction
            const t1 = ph[j] / dts[j];
            if (t1 < 1) saw -= t1 + t1 - t1 * t1 - 1;
            const t2 = (1 - ph[j]) / dts[j];
            if (t2 < 1) saw += t2 * t2 - t2 - t2 + 1;
            sum += saw;
          }
          buf[i] += sum * (1 / 7) * voiceGain;
        }
        v.gains[0] = voiceGain;
      } else if (isNoise) {
        // Unity-gain bandpass noise carrier (Csound resonz topology).
        // Zeros at DC and Nyquist via (y0 - y2) cancel the all-pole
        // resonator's 1/sin(w) frequency dependence. Gain normalization
        // (1-r²)/2 makes peak gain exactly 1.0 at all frequencies.
        // No ampScale needed — voiceGain from sensor bins is the sole
        // amplitude control, same path as sine carrier.
        const w = twoPi * v.freq * invSr;
        const r = Math.max(0.9, Math.min(0.9999, 1 - Math.PI * v.freq / (25 * sampleRate)));
        const c1 = 2 * r * Math.cos(w);
        const c2 = -(r * r);
        const norm = (1 - r * r) / 2;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        let y1 = v.bp1, y2 = v.bp2;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          const noise = Math.random() * 2 - 1;
          const y0 = noise + c1 * y1 + c2 * y2;
          const bp = (y0 - y2) * norm;
          y2 = y1; y1 = y0;
          buf[i] += bp * voiceGain * 8;
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
    // Soft limiter: always-on tanh avoids the sharp knee at ±0.8 that
    // caused intermodulation clicks with many simultaneous voices.
    // tanh(x) ≈ x for small x, compresses gradually for larger values.
    for (let i = 0; i < len; i++) buf[i] = ftanh(buf[i]);
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
    this.raysPer = 512;
  }

  setPartials(n) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'partials', value: n });
  }

  setFmRatio(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'fmRatio', value: v });
  }

  setFmDepth(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'fmDepth', value: v });
  }

  setSsDetune(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'ssDetune', value: v });
  }

  setAcidRes(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'acidRes', value: v });
  }

  setAcidEnv(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'acidEnv', value: v });
  }

  setAcidCutoff(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'acidCutoff', value: v });
  }

  setAcidDecay(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'acidDecay', value: v });
  }

  setAcidDrive(v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'acidDrive', value: v });
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
    if (!AC) throw new Error('AudioContext not supported');
    this.ctx = new AC();
    // Mobile browsers create AudioContext in suspended state.
    // Must resume within a user gesture.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.ctx.audioWorklet) {
      this.ctx.close();
      this.ctx = null;
      throw new Error('AudioWorklet not supported (requires HTTPS)');
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume ?? 0.25;
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
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;
    this.freqFloat = new Float32Array(this.analyser.frequencyBinCount);
    this.workletNode.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
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
    const loHz = 80, hiHz = 6000;
    const baseHz = this.baseHz ?? 130.81;
    const stepDeg = this.stepSemi ?? 1;
    const scaleName = (this.mode && this.mode !== 'log') ? this.mode : 'chromatic';
    const freqs = new Float32Array(sensorCount);
    for (let i = 0; i < sensorCount; i++) {
      if (this.mode !== 'log') {
        freqs[i] = scaleFreq(baseHz, scaleName, i, stepDeg);
      } else {
        const t = (i + 0.5) / sensorCount;
        freqs[i] = loHz * Math.pow(hiHz / loHz, t);
      }
    }
    this.workletNode.port.postMessage({
      type: 'rebuild',
      freqs,
      binCount: 64,
      sensorCount,
      fullScale: 1.6 * Math.sqrt(this.raysPer),
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
    this.analyser?.disconnect();
    this.analyser = null;
    this.freqFloat = null;
    this.master?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.active = false;
    this.count = 0;
  }
}
