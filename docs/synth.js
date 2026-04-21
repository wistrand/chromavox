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
import { CARRIERS, ALL_PARAM_IDS, PARAM_DEFAULTS } from './carriers.js';

export const _WORKLET_SRC = `
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

// Fast sine via lookup table. 2048 entries over [0, 2π].
// Linear interpolation. Replaces Math.sin in inner loops (~3-5× faster).
const _SIN_N = 2048;
const _SIN_TBL = new Float32Array(_SIN_N + 1);
for (let i = 0; i <= _SIN_N; i++) {
  _SIN_TBL[i] = Math.sin(i / _SIN_N * 2 * Math.PI);
}
const _SIN_INC = _SIN_N / (2 * Math.PI);
function fsin(x) {
  const t = ((x % (2 * Math.PI)) + 2 * Math.PI) * _SIN_INC;
  const i = t | 0;
  const f = t - i;
  return _SIN_TBL[i % _SIN_N] + (_SIN_TBL[(i + 1) % _SIN_N] - _SIN_TBL[i % _SIN_N]) * f;
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
    this.carrier = 'sine';
    // Carrier params — defaults injected from carriers.js at build time.
    this.P = ${JSON.stringify(PARAM_DEFAULTS)};
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'bins') {
        this.bins = d.bins;
      } else if (d.type === 'rebuild') {
        this._rebuild(d.freqs, d.binCount, d.sensorCount, d.fullScale);
      } else if (d.type === 'partials') {
        this.partials = d.value;
        this.P.partials = d.value;
        if (this.sensorCount > 0) this._rebuildPartials();
      } else if (d.type === 'carrier') {
        this.carrier = d.value;
      } else if (d.type in this.P) {
        this.P[d.type] = d.value;
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
      // Karplus-Strong delay line: length = ceil(sampleRate / freq).
      const kpLen = Math.max(2, Math.ceil(sampleRate / f));
      this.voices.push({ freq: f, phases, gains, targetGains,
        bp1: 0, bp2: 0,
        sawPhase: 0, lp1: 0, lp2: 0, lp3: 0, smoothCutoff: -1,
        modPhase: 0,
        ssPhases: new Float32Array(7),
        centroid: 0.5, targetCentroid: 0.5,
        pulsePhase: 0,
        kpBuf: new Float32Array(kpLen), kpIdx: 0, kpPrev: 0, kpGainPrev: 0,
        kpExLp: 0,
        // Vocoder: 4th-order bandpass = two cascaded biquads.
        voc1: new Float32Array(4), voc2: new Float32Array(4), // [x1,x2,y1,y2] per biquad
        vocEnv: 0, vocPulsePhase: 0 });
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0] || this.voices.length === 0) return true;
    const bufL = out[0];
    const bufR = out[1] || out[0]; // fallback to mono if no R channel
    const len = bufL.length;
    const bins = this.bins;
    const K = this.partials;
    const bc = this.binCount;
    const sc = this.sensorCount;
    const isNoise = this.carrier === 'noise';
    const isAcid = this.carrier === 'acid';
    const isFM = this.carrier === 'fm';
    const isSupersaw = this.carrier === 'supersaw';
    const isPulse = this.carrier === 'pulse';
    const isKarplus = this.carrier === 'karplus';
    const isVocoder = this.carrier === 'vocoder';
    // Compute target gains from latest bins snapshot.
    // Normalize by fullScale (BASE_INTENSITY * sqrt(raysPer)) to recover
    // the 0-1 micGain scale, then apply floor + gamma. This matches the
    // mic spectrum's absolute scaling so quiet voices stay quiet.
    // Noise and acid carriers use K=1 (single band per voice).
    if (bins && bins.length >= sc * bc) {
      const fs = this.fullScale;
      const gainK = (isNoise || isAcid || isFM || isSupersaw || isPulse || isKarplus || isVocoder) ? 1 : K;
      const partialFS = fs / gainK;
      const voiceScale = 1 / Math.sqrt(sc * gainK);
      const singleBand = gainK === 1;
      for (let s = 0; s < sc; s++) {
        const v = this.voices[s];
        const nk = v.targetGains.length;
        // For non-sine carriers (single band), compute spectral centroid
        // from the wavelength bins: sum(val * idx) / sum(val), 0-1.
        // Falls back to voice position (sensor index / count) when the
        // sensor-side wavelength distribution is uniform (passthrough).
        let centroidNum = 0, centroidDen = 0;
        for (let k = 0; k < nk; k++) {
          if (k >= gainK) { v.targetGains[k] = 0; continue; }
          // Invert bin mapping: blue (low bins, short wavelength) drives
          // high partials; red (high bins, long wavelength) drives the
          // fundamental. Reversed k index into the bin range.
          const rk = gainK - 1 - k;
          const b0 = (rk * bc / gainK) | 0;
          const b1 = ((rk + 1) * bc / gainK) | 0;
          let sum = 0;
          for (let b = b0; b < b1; b++) {
            const val = bins[s * bc + b];
            sum += val;
            if (singleBand) {
              centroidNum += val * b;
              centroidDen += val;
            }
          }
          const g = Math.min(1, sum / partialFS);
          v.targetGains[k] = g < 0.02 ? 0
            : ((g - 0.02) / 0.98) * voiceScale / (k + 1);
        }
        if (singleBand) {
          // Spectral centroid from wavelength bins, inverted so that
          // blue (short wavelength, low bins) → 1.0 (brighter/higher)
          // and red (long wavelength, high bins) → 0.0 (duller/lower).
          const rawCentroid = centroidDen > 1e-6
            ? centroidNum / (centroidDen * (bc - 1)) : 0.5;
          const wlCentroid = 1 - rawCentroid;
          // Position centroid: sensor 0 = bottom = short wavelength = blue → 1.0.
          const posCentroid = sc > 1 ? 1 - s / (sc - 1) : 0.5;
          // Blend: use wavelength centroid when it deviates from the
          // uniform baseline (~0.575 after inversion); otherwise position.
          const wlDeviation = Math.abs(wlCentroid - 0.575);
          const blend = Math.min(1, wlDeviation * 10);
          v.targetCentroid = wlCentroid * blend + posCentroid * (1 - blend);
        }
      }
    }
    // Synthesise.
    const twoPi = 2 * Math.PI;
    const invSr = 1 / sampleRate;
    // Per-carrier gain smoothing time constants (seconds).
    // Karplus needs fast attack for pluck transients; sine benefits
    // from slower transitions to reduce intermodulation.
    const smoothSec = isKarplus ? 0.005 : isPulse ? 0.03
      : isAcid ? 0.04 : (isNoise || isFM || isSupersaw) ? 0.06 : 0.08;
    const smooth = 1 - Math.exp(-1 / (smoothSec * sampleRate));
    // Block-rate smoothing for centroid (applied once per block, not per sample).
    const centroidSmooth = 1 - Math.pow(1 - smooth, len);
    for (let i = 0; i < len; i++) { bufL[i] = 0; bufR[i] = 0; }
    const voices = this.voices;
    const voiceCount = voices.length;
    let _activeCount = 0;

    // Vocoder shared excitation: one broadband signal for all voices.
    // Pulse is a PolyBLEP saw at a fixed low pitch (100 Hz) so all
    // bandpass filters extract harmonics from the same rich spectrum.
    let _vocExc = null;
    if (isVocoder) {
      const excite = this.P.vocExcite ?? 0.5;
      const useNoise = excite < 0.66;
      const usePulse = excite > 0.33;
      const noiseMix = useNoise ? Math.min(1, (0.66 - excite) / 0.33) : 0;
      const pulseMix = usePulse ? Math.min(1, (excite - 0.33) / 0.33) : 0;
      const basePitch = 100; // fixed excitation pitch
      const pdt = basePitch * invSr;
      if (!this._vocPhase) this._vocPhase = 0;
      _vocExc = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let exc = 0;
        if (useNoise) exc += (Math.random() * 2 - 1) * noiseMix;
        if (usePulse) {
          this._vocPhase += pdt;
          if (this._vocPhase >= 1) this._vocPhase -= 1;
          let saw = 2 * this._vocPhase - 1;
          const t1 = this._vocPhase / pdt;
          if (t1 < 1) saw -= t1 + t1 - t1 * t1 - 1;
          const t2 = (1 - this._vocPhase) / pdt;
          if (t2 < 1) saw += t2 * t2 - t2 - t2 + 1;
          exc += saw * pulseMix;
        }
        _vocExc[i] = exc;
      }
    }
    // Constant-power pan per voice: sensor 0 (bottom) → left,
    // sensor N-1 (top) → right. PI/2 sweep.
    const _halfPi = Math.PI * 0.5;
    for (let s = 0; s < voiceCount; s++) {
      const pan = voiceCount > 1 ? s / (voiceCount - 1) : 0.5;
      const panL = Math.cos(pan * _halfPi);
      const panR = Math.sin(pan * _halfPi);
      const v = voices[s];
      // Overall voice gain = sum of partial target gains (for noise mode).
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      if (!anyActive) {
        v.bp1 = 0; v.bp2 = 0; v.lp1 = 0; v.lp2 = 0; v.lp3 = 0; v.smoothCutoff = -1;
        // Clear vocoder biquad states so reactivation doesn't ring.
        if (v.voc1) { v.voc1[0] = v.voc1[1] = v.voc1[2] = v.voc1[3] = 0; }
        if (v.voc2) { v.voc2[0] = v.voc2[1] = v.voc2[2] = v.voc2[3] = 0; }
        v.vocEnv = 0;
        continue;
      }
      _activeCount++;

      if (isAcid) {
        // 303-style acid carrier: PolyBLEP sawtooth → 3-pole TPT/ZDF
        // diode ladder filter with tanh feedback → drive.
        // Spectral centroid shifts the base cutoff: blue light → brighter,
        // red light → duller. ±2 octaves from center.
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const baseFreq = v.freq;
        const dt = baseFreq * invSr;
        const acidRes = this.P.acidRes;
        const acidEnv = this.P.acidEnv;
        // Base cutoff: 80-8000 Hz log-mapped from the knob [0,1],
        // then shifted ±2 octaves by spectral centroid.
        const centroidShift = Math.pow(2, (v.centroid - 0.5) * 4);
        const baseCutoffHz = 80 * Math.pow(100, this.P.acidCutoff) * centroidShift;
        // Seed smoothCutoff on first activation so the filter doesn't
        // start with g=tan(0)=0 (silent first block).
        if (v.smoothCutoff < 0) v.smoothCutoff = baseCutoffHz;
        // Decay: per-sample smoothing constant. Maps [0,1] → 30ms-2s.
        // Lower values = longer decay = slower squelch = more 303.
        const decayMs = 0.03 + this.P.acidDecay * 1.97; // 30ms to 2s
        const envSmooth = 1 - Math.exp(-1 / (decayMs * sampleRate));
        // Drive: 1× (clean) to 5× (screaming).
        const driveAmt = 1 + this.P.acidDrive * 4;
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
        // Compute tan(g) every 32 samples to reduce zipper noise from
        // stepped filter coefficients during fast cutoff sweeps.
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
          // Recompute filter coefficient every 32 samples.
          if ((i & 31) === 31) { g = Math.tan(piInvSr * sCutoff); g1 = g / (1 + g); }
          // Input with resonance feedback.
          const u = saw * 1.5 - k * ftanh(s3);
          // 3 cascaded one-poles (18 dB/oct diode ladder)
          const v1 = (u - s1) * g1; s1 += 2 * v1;
          const v2 = (s1 - s2) * g1; s2 += 2 * v2;
          const v3 = (s2 - s3) * g1; s3 += 2 * v3;
          // Post-filter drive.
          const driven = ftanh(s3 * driveAmt);
          const _s = driven * voiceGain;
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.sawPhase = phase;
        v.lp1 = s1; v.lp2 = s2; v.lp3 = s3;
        v.smoothCutoff = sCutoff;
        v.gains[0] = voiceGain;
      } else if (isFM) {
        // FM synthesis carrier. Spectral centroid modulates the FM ratio:
        // blue → higher ratio (brighter harmonics), red → lower (purer).
        // ±50% of the base ratio.
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const cFreq = v.freq;
        const ratioMod = 1 + (v.centroid - 0.5);  // 0.5x – 1.5x
        const mFreq = cFreq * this.P.fmRatio * ratioMod;
        const maxIndex = this.P.fmDepth * 8; // mod index 0-8
        const cInc = twoPi * cFreq * invSr;
        const mInc = twoPi * mFreq * invSr;
        let cPhase = v.phases.length > 0 ? v.phases[0] : 0;
        let mPhase = v.modPhase;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          const modIndex = voiceGain * maxIndex;
          const mod = fsin(mPhase) * modIndex;
          const sample = fsin(cPhase + mod) * voiceGain;
          bufL[i] += sample * panL; bufR[i] += sample * panR;
          cPhase += cInc;
          mPhase += mInc;
          if (cPhase > twoPi) cPhase -= twoPi;
          if (mPhase > twoPi) mPhase -= twoPi;
        }
        if (v.phases.length > 0) v.phases[0] = cPhase;
        v.modPhase = mPhase;
        v.gains[0] = voiceGain;
      } else if (isSupersaw) {
        // Supersaw: 7 detuned saws. Spectral centroid modulates detune:
        // blue → wider (thick chorus), red → tighter (clean unison).
        // ±100% of the base detune.
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const baseFreq = v.freq;
        const detuneMod = v.centroid * 2;  // 0x–2x of base detune
        const maxCents = this.P.ssDetune * 50 * detuneMod;
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
          const _s = sum * (1 / 7) * voiceGain;
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.gains[0] = voiceGain;
      } else if (isNoise) {
        // Unity-gain bandpass noise carrier (Csound resonz topology).
        // Spectral centroid shifts the bandpass center: blue → higher,
        // red → lower. ±1 octave from the voice's base frequency.
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        const centroidShift = Math.pow(2, (v.centroid - 0.5) * 2);
        const noiseQ = Math.max(1, this.P.noiseQ || 14);
        const freqMod = Math.min(sampleRate * 0.45, v.freq * centroidShift);
        const w = twoPi * freqMod * invSr;
        const r = Math.max(0.9, Math.min(0.9999, 1 - Math.PI * freqMod / (noiseQ * sampleRate)));
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
          const _s = bp * voiceGain * 8;
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.bp1 = y1; v.bp2 = y2;
        v.gains[0] = voiceGain;
      } else if (isPulse) {
        // PolyBLEP variable-width pulse wave. Spectral centroid modulates
        // duty cycle: blue (1) → narrow (buzzy), red (0) → wide (warm).
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        const baseWidth = this.P.pulseWidth || 0.5;
        // Centroid modulates ±0.35 around the base width.
        const duty = Math.max(0.05, Math.min(0.95,
          baseWidth + (0.5 - v.centroid) * 0.7));
        const baseFreq = v.freq;
        const dt = baseFreq * invSr;
        let phase = v.pulsePhase;
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          phase += dt;
          if (phase >= 1) phase -= 1;
          // Raw pulse: +1 when phase < duty, -1 otherwise.
          let pulse = phase < duty ? 1 : -1;
          // PolyBLEP at the rising edge (phase ≈ 0).
          const t1 = phase / dt;
          if (t1 < 1) pulse += t1 + t1 - t1 * t1 - 1;
          const t1b = (1 - phase) / dt;
          if (t1b < 1) pulse -= t1b * t1b - t1b - t1b + 1;
          // PolyBLEP at the duty-cycle crossing (phase ≈ duty).
          const t2 = (phase - duty) / dt;
          if (t2 > 0 && t2 < 1) pulse -= t2 + t2 - t2 * t2 - 1;
          const t2b = (duty - phase) / dt;
          if (t2b > 0 && t2b < 1) pulse += t2b * t2b - t2b - t2b + 1;
          const _s = pulse * voiceGain;
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.pulsePhase = phase;
        v.gains[0] = voiceGain;
      } else if (isVocoder) {
        // Classic vocoder: shared broadband excitation → 4th-order
        // bandpass (two cascaded biquads) → envelope-modulated output.
        // Q is auto-computed from voice spacing for non-overlapping bands.
        const voiceTarget = v.targetGains[0];
        const freq = v.freq;
        // Auto-Q: bandwidth = gap to next voice. For N log-spaced voices,
        // ratio = (hiHz/loHz)^(1/N). BW = freq × (ratio-1). Q = 1/(ratio-1).
        const ratio = sc > 1 ? Math.pow(6000 / 80, 1 / sc) : 2;
        const bw = freq * (ratio - 1);
        const Q = Math.max(1, freq / bw);
        // Biquad BPF coefficients (Audio EQ Cookbook, Robert Bristow-Johnson).
        const w0 = twoPi * freq * invSr;
        const sinW = Math.sin(w0), cosW = Math.cos(w0);
        const alpha = sinW / (2 * Q);
        const a0inv = 1 / (1 + alpha);
        const b0 =  (sinW / 2) * a0inv;
        const b1 =  0;
        const b2 = -(sinW / 2) * a0inv;
        const a1 = (-2 * cosW) * a0inv;
        const a2 = (1 - alpha) * a0inv;
        // Envelope: fast attack/release in ms → per-sample coefficients.
        const atkMs = this.P.vocAttack ?? 5;
        const relMs = this.P.vocRelease ?? 20;
        const atkCoeff = 1 - Math.exp(-1 / (atkMs * 0.001 * sampleRate));
        const relCoeff = 1 - Math.exp(-1 / (relMs * 0.001 * sampleRate));
        let env = v.vocEnv;
        const s1 = v.voc1, s2 = v.voc2; // biquad states [x1,x2,y1,y2]
        // Gain normalization: at Q=10, peak gain ≈ Q. Compensate.
        const gainNorm = 1 / Math.max(1, Q * 0.5);
        for (let i = 0; i < len; i++) {
          // Envelope follower: fast attack, slower release.
          env += (voiceTarget - env) * (voiceTarget > env ? atkCoeff : relCoeff);
          // Apply envelope to excitation BEFORE filtering — prevents
          // biquad state buildup during silence that clicks on onset.
          const exc = _vocExc[i] * env;
          // First biquad.
          let y = b0 * exc + b1 * s1[0] + b2 * s1[1] - a1 * s1[2] - a2 * s1[3];
          s1[1] = s1[0]; s1[0] = exc; s1[3] = s1[2]; s1[2] = y;
          // Second biquad (cascade for 4th order / 24 dB/oct).
          const y2 = b0 * y + b1 * s2[0] + b2 * s2[1] - a1 * s2[2] - a2 * s2[3];
          s2[1] = s2[0]; s2[0] = y; s2[3] = s2[2]; s2[2] = y2;
          const _s = y2 * gainNorm * 4;
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.vocEnv = env;
        v.gains[0] = voiceTarget;
      } else if (isKarplus) {
        // Karplus-Strong plucked string. Delay line with lowpass feedback.
        // Sensor energy re-excites the string; spectral centroid modulates
        // damping: blue (1) → bright/long ring, red (0) → dark/short thud.
        v.centroid += (v.targetCentroid - v.centroid) * centroidSmooth;
        let voiceGain = v.gains[0];
        const voiceTarget = v.targetGains[0];
        // Damping: 0 = heavy (short, dark), 1 = light (long, bright).
        // Centroid adds ±0.3 to the base damping.
        const baseDamp = this.P.kpDamping || 0.4;
        const dampMod = Math.max(0, Math.min(1,
          baseDamp + (v.centroid - 0.5) * 0.6));
        // Feedback coefficient: higher = longer sustain.
        const fb = 0.9 + dampMod * 0.099; // 0.9 – 0.999
        // Lowpass blend in the feedback loop: 0 = full averaging (dark),
        // 1 = no averaging (bright). Centroid/damping controls this so
        // blue-shifted voices stay bright instead of converging to buzz.
        const lpBlend = dampMod * 0.6; // 0 – 0.6
        // Excite slider controls the balance between continuous
        // excitation (sustained, bowed-string-like) and transient-only
        // (plucked, re-excited on rising edges). Low = more continuous,
        // high = more plucky.
        const exciteAmt = this.P.kpExcite || 0.5;
        const kpBuf = v.kpBuf;
        const kpLen = kpBuf.length;
        let idx = v.kpIdx;
        let prev = v.kpPrev;
        // Transient re-excitation on rising edge.
        const gainRising = voiceTarget >= 0.05 && v.kpGainPrev < 0.05;
        if (gainRising) {
          for (let j = 0; j < kpLen; j++) {
            kpBuf[j] += (Math.random() * 2 - 1) * voiceTarget * 0.5;
          }
        }
        v.kpGainPrev = voiceTarget;
        // Continuous excitation: inject noise proportional to sensor
        // energy each sample. Scaled by (1 - exciteAmt) so at full
        // Excite the string is purely plucked, at zero it's bowed.
        const contExcite = (1 - exciteAmt) * 0.4;
        // Excitation filter: one-pole lowpass on the injected noise.
        // Blue centroid (1) → high cutoff (bright, shimmery excitation).
        // Red centroid (0) → low cutoff (dark, woody excitation).
        // Coefficient: 0 = fully filtered, 1 = unfiltered white noise.
        const exFiltCoeff = 0.05 + v.centroid * 0.9; // 0.05 – 0.95
        let exLp = v.kpExLp;
        // Lowpass coefficients for feedback: blend between pure averaging
        // (dark) and passthrough (bright) based on damping/centroid.
        const lpA = 0.5 + lpBlend * 0.5; // weight of current sample: 0.5 – 0.8
        const lpB = 1 - lpA;              // weight of previous sample: 0.5 – 0.2
        for (let i = 0; i < len; i++) {
          voiceGain += (voiceTarget - voiceGain) * smooth;
          // Inject filtered noise into the delay line at the write head.
          if (voiceGain > 0.01) {
            const white = Math.random() * 2 - 1;
            exLp += (white - exLp) * exFiltCoeff;
            kpBuf[idx] += exLp * voiceGain * contExcite;
          }
          // Read from delay line.
          const out = kpBuf[idx];
          // Variable lowpass in feedback: bright voices keep more highs.
          const filtered = (out * lpA + prev * lpB) * fb;
          prev = out;
          // Write back.
          kpBuf[idx] = filtered;
          idx++;
          if (idx >= kpLen) idx = 0;
          const _s = out * Math.min(1, voiceGain * 3);
          bufL[i] += _s * panL; bufR[i] += _s * panR;
        }
        v.kpIdx = idx;
        v.kpPrev = prev;
        v.kpExLp = exLp;
        v.gains[0] = voiceGain;
      } else {
        // Sine / harmonic carrier.
        for (let i = 0; i < len; i++) {
          let sample = 0;
          for (let k = 0; k < v.phases.length; k++) {
            v.gains[k] += (v.targetGains[k] - v.gains[k]) * smooth;
            if (v.gains[k] < 1e-6 && v.targetGains[k] < 1e-6) continue;
            sample += fsin(v.phases[k]) * v.gains[k];
            v.phases[k] += twoPi * v.freq * (k + 1) * invSr;
            if (v.phases[k] > twoPi) v.phases[k] -= twoPi;
          }
          bufL[i] += sample * panL; bufR[i] += sample * panR;
        }
      }
    }
    this._lastActiveCount = _activeCount;
    // Soft limiter on both channels.
    for (let i = 0; i < len; i++) { bufL[i] = ftanh(bufL[i]); bufR[i] = ftanh(bufR[i]); }
    // Dropped-buffer detection: currentFrame should advance by exactly
    // 128 (render quantum) between calls. A gap > 128 = missed callback.
    if (this._prevFrame !== undefined) {
      const gap = currentFrame - this._prevFrame;
      if (gap > 128) this._droppedBuffers = (this._droppedBuffers || 0) + (gap / 128 - 1);
    }
    this._prevFrame = currentFrame;
    // Stats: report every ~500ms.
    this._processCount = (this._processCount || 0) + 1;
    if (this._processCount >= 187) { // ~500ms at 48kHz/128 samples
      this.port.postMessage({
        type: 'stats',
        voices: this.voices.length,
        activeVoices: this._lastActiveCount || 0,
        carrier: this.carrier,
        blockSize: len,
        droppedBuffers: this._droppedBuffers || 0,
      });
      this._droppedBuffers = 0;
      this._processCount = 0;
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
    this.raysPer = 512;
  }

  setPartials(n) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'partials', value: n });
  }

  // Generic carrier param setter — works for all params in carriers.js.
  setParam(id, v) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: id, value: v });
  }

  setCarrier(mode) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'carrier', value: mode });
  }

  setStep(stepSemi) {
    if (this.stepSemi === stepSemi) return;
    this.stepSemi = stepSemi;
    if (this.active && this.mode !== 'log' && this.mode !== 'voice') this.rebuild(this.count);
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
    const blob = new Blob([_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.workletNode = new AudioWorkletNode(this.ctx, 'chromavox-synth', {
      outputChannelCount: [2],
    });
    // Receive timing stats from the worklet thread.
    this.workletNode.port.onmessage = e => {
      if (e.data.type === 'stats') this.stats = e.data;
    };
    this.stats = null;
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
    const isLog = this.mode === 'log' || this.mode === 'voice';
    const loHz = this.mode === 'voice' ? 100 : 80;
    const hiHz = this.mode === 'voice' ? 4000 : 6000;
    const baseHz = this.baseHz ?? 130.81;
    const stepDeg = this.stepSemi ?? 1;
    const scaleName = (this.mode && !isLog) ? this.mode : 'chromatic';
    const freqs = new Float32Array(sensorCount);
    for (let i = 0; i < sensorCount; i++) {
      if (!isLog) {
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
