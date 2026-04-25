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
// Fast variant that assumes the caller keeps phase in table-index
// space — i.e. in [0, _SIN_N) — and handles its own wrap. Saves one
// float modulo + three int modulos + a duplicate load per call vs
// fsin(). Used by sine and piano, which both store their phases in
// index units and wrap per sample. Boundary-safe because _SIN_TBL
// has _SIN_N+1 entries with _SIN_TBL[_SIN_N] == _SIN_TBL[0] == 0.
function fsinFast(x) {
  const i = x | 0;
  const f = x - i;
  const a = _SIN_TBL[i];
  const b = _SIN_TBL[i + 1];
  return a + (b - a) * f;
}

// Mulberry32 PRNG for non-inner-loop noise paths. Used only for vocoder
// shared excitation (one PRNG, not per-voice) and karplus init bursts
// (one-shot per note-on). Hot per-sample-per-voice paths (_carrierNoise,
// _carrierKarplus continuous excitation) deliberately keep Math.random()
// to avoid the inter-voice correlation artifact that surfaces when many
// voices pull from the same PRNG sequence.
let _rngState = 0xDEADBEEF | 0;
function _rng() {
  _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --- Carrier functions. Each takes (v, ctx) where v is the voice
// struct and ctx is the shared per-block context object. ---

function _carrierAcid(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const dt = v.freq * ctx.invSr;
  const centroidShift = Math.pow(2, (v.centroid - 0.5) * 4);
  const baseCutoffHz = 80 * Math.pow(100, ctx.P.acidCutoff) * centroidShift;
  if (v.smoothCutoff < 0) v.smoothCutoff = baseCutoffHz;
  const decayMs = 0.03 + ctx.P.acidDecay * 1.97;
  const envSmooth = 1 - Math.exp(-1 / (decayMs * sampleRate));
  const driveAmt = 1 + ctx.P.acidDrive * 4;
  const k = ctx.P.acidRes * 4.5;
  let phase = v.sawPhase;
  let s1 = v.lp1, s2 = v.lp2, s3 = v.lp3;
  let sCutoff = v.smoothCutoff;
  const envScale = ctx.P.acidEnv * 5;
  const ln2 = 0.6931471805599453;
  const piInvSr = Math.PI * ctx.invSr;
  const cutoffCeil = sampleRate * 0.45;
  let g = Math.tan(piInvSr * sCutoff);
  let g1 = g / (1 + g);
  // Block-rate target cutoff: recomputed only at the 32-sample guard
  // (same rate as g/g1). sCutoff's per-sample one-pole lerp smooths the
  // stairstep. Math.exp is ~50 cycles; at 48kHz this saves ~6M cycles/sec.
  let targetCutoff = Math.min(cutoffCeil,
    baseCutoffHz * Math.exp(voiceGain * envScale * ln2));
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    phase += dt;
    let saw = 2 * phase - 1;
    if (phase >= 1) { phase -= 1; saw = 2 * phase - 1; }
    if (phase < dt) { const t = phase / dt; saw += (1 - t) * (1 - t); }
    else if (phase > 1 - dt) { const t = (1 - phase) / dt; saw += (1 - t) * (1 - t); }
    sCutoff += (targetCutoff - sCutoff) * envSmooth;
    if ((i & 31) === 31) {
      targetCutoff = Math.min(cutoffCeil,
        baseCutoffHz * Math.exp(voiceGain * envScale * ln2));
      g = Math.tan(piInvSr * sCutoff);
      g1 = g / (1 + g);
    }
    const u = saw * 1.5 - k * ftanh(s3);
    const v1 = (u - s1) * g1; s1 += 2 * v1;
    const v2 = (s1 - s2) * g1; s2 += 2 * v2;
    const v3 = (s2 - s3) * g1; s3 += 2 * v3;
    const _s = ftanh(s3 * driveAmt) * voiceGain;
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  // Denormal guard: IIR states can decay into subnormal range during
  // sustained silence, triggering a 10-100× slowdown on x86 without FTZ.
  if (Math.abs(s1) < 1e-20) s1 = 0;
  if (Math.abs(s2) < 1e-20) s2 = 0;
  if (Math.abs(s3) < 1e-20) s3 = 0;
  v.sawPhase = phase; v.lp1 = s1; v.lp2 = s2; v.lp3 = s3;
  v.smoothCutoff = sCutoff; v.gains[0] = voiceGain;
}

function _carrierFM(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const cFreq = v.freq;
  const ratioMod = 1 + (v.centroid - 0.5);
  const mFreq = cFreq * ctx.P.fmRatio * ratioMod;
  const maxIndex = ctx.P.fmDepth * 8;
  const cInc = ctx.twoPi * cFreq * ctx.invSr;
  const mInc = ctx.twoPi * mFreq * ctx.invSr;
  let cPhase = v.phases.length > 0 ? v.phases[0] : 0;
  let mPhase = v.modPhase;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    const sample = fsin(cPhase + fsin(mPhase) * voiceGain * maxIndex) * voiceGain;
    ctx.bufL[i] += sample * ctx.panL; ctx.bufR[i] += sample * ctx.panR;
    cPhase += cInc; mPhase += mInc;
    if (cPhase > ctx.twoPi) cPhase -= ctx.twoPi;
    if (mPhase > ctx.twoPi) mPhase -= ctx.twoPi;
  }
  if (v.phases.length > 0) v.phases[0] = cPhase;
  v.modPhase = mPhase; v.gains[0] = voiceGain;
}

function _carrierSupersaw(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const baseFreq = v.freq;
  const maxCents = ctx.P.ssDetune * 50 * v.centroid * 2;
  const c3 = Math.pow(2, maxCents / 3 / 1200);
  const c6 = Math.pow(2, maxCents * 2 / 3 / 1200);
  const c9 = Math.pow(2, maxCents / 1200);
  const bfi = baseFreq * ctx.invSr;
  // Reuse voice's ssPhases array second half as scratch for dts (7 floats).
  // ssPhases is Float32Array(7), dts needs 7 — but they're both in use.
  // Use a scratch array on the voice instead.
  if (!v._ssDts) v._ssDts = new Float32Array(7);
  const dts = v._ssDts;
  dts[0] = bfi; dts[1] = bfi * c3; dts[2] = bfi / c3;
  dts[3] = bfi * c6; dts[4] = bfi / c6; dts[5] = bfi * c9; dts[6] = bfi / c9;
  const ph = v.ssPhases;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    let sum = 0;
    for (let j = 0; j < 7; j++) {
      ph[j] += dts[j];
      let saw = 2 * ph[j] - 1;
      if (ph[j] >= 1) { ph[j] -= 1; saw = 2 * ph[j] - 1; }
      const t1 = ph[j] / dts[j];
      if (t1 < 1) saw -= t1 + t1 - t1 * t1 - 1;
      const t2 = (1 - ph[j]) / dts[j];
      if (t2 < 1) saw += t2 * t2 - t2 - t2 + 1;
      sum += saw;
    }
    const _s = sum * (1/7) * voiceGain;
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  v.gains[0] = voiceGain;
}

function _carrierNoise(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  const centroidShift = Math.pow(2, (v.centroid - 0.5) * 2);
  const noiseQ = Math.max(1, ctx.P.noiseQ || 14);
  const freqMod = Math.min(sampleRate * 0.45, v.freq * centroidShift);
  const w = ctx.twoPi * freqMod * ctx.invSr;
  const r = Math.max(0.9, Math.min(0.9999, 1 - Math.PI * freqMod / (noiseQ * sampleRate)));
  const c1 = 2 * r * Math.cos(w), c2 = -(r * r), norm = (1 - r * r) / 2;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  let y1 = v.bp1, y2 = v.bp2;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    const noise = Math.random() * 2 - 1;
    const y0 = noise + c1 * y1 + c2 * y2;
    const bp = (y0 - y2) * norm;
    y2 = y1; y1 = y0;
    const _s = bp * voiceGain * 8;
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  // Denormal guard on bandpass states.
  if (Math.abs(y1) < 1e-20) y1 = 0;
  if (Math.abs(y2) < 1e-20) y2 = 0;
  v.bp1 = y1; v.bp2 = y2; v.gains[0] = voiceGain;
}

function _carrierPulse(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const duty = Math.max(0.05, Math.min(0.95,
    (ctx.P.pulseWidth || 0.5) + (0.5 - v.centroid) * 0.7));
  const dt = v.freq * ctx.invSr;
  let phase = v.pulsePhase;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    phase += dt;
    if (phase >= 1) phase -= 1;
    let pulse = phase < duty ? 1 : -1;
    const t1 = phase / dt;
    if (t1 < 1) pulse += t1 + t1 - t1 * t1 - 1;
    const t1b = (1 - phase) / dt;
    if (t1b < 1) pulse -= t1b * t1b - t1b - t1b + 1;
    const t2 = (phase - duty) / dt;
    if (t2 > 0 && t2 < 1) pulse -= t2 + t2 - t2 * t2 - 1;
    const t2b = (duty - phase) / dt;
    if (t2b > 0 && t2b < 1) pulse += t2b * t2b - t2b - t2b + 1;
    const _s = pulse * voiceGain;
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  v.pulsePhase = phase; v.gains[0] = voiceGain;
}

function _carrierVocoder(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  const voiceTarget = v.targetGains[0];
  // Spectral centroid modulates Q: blue-dominant input (high centroid)
  // tightens the formant filter; red-dominant input widens it. Range is
  // roughly ±1 octave on Q — a focused vowel vs. a breathy one.
  const qMod = Math.pow(2, (v.centroid - 0.5) * 2);
  const Q = Math.max(1, ctx.vocQ * qMod);
  // Per-voice biquad coefficients (depend on freq and Q).
  const w0 = ctx.twoPi * v.freq * ctx.invSr;
  const sinW = Math.sin(w0), cosW = Math.cos(w0);
  const alpha = sinW / (2 * Q);
  const a0inv = 1 / (1 + alpha);
  const b0 = (sinW / 2) * a0inv, b2 = -(sinW / 2) * a0inv;
  const a1 = (-2 * cosW) * a0inv, a2 = (1 - alpha) * a0inv;
  const atkCoeff = ctx.vocAtk, relCoeff = ctx.vocRel;
  const gainNorm = 1 / Math.max(1, Q * 0.5);
  const vocExc = ctx.vocExc;
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  let env = v.vocEnv;
  // DF-II Transposed: two states per biquad instead of four. b1 = 0 for BPF.
  // y = b0*x + z1;  z1 = z2 - a1*y;  z2 = b2*x - a2*y
  let z1a = v.voc1[0], z2a = v.voc1[1];
  let z1b = v.voc2[0], z2b = v.voc2[1];
  for (let i = 0; i < len; i++) {
    env += (voiceTarget - env) * (voiceTarget > env ? atkCoeff : relCoeff);
    const exc = vocExc[i] * env;
    const y = b0 * exc + z1a;
    z1a = z2a - a1 * y;
    z2a = b2 * exc - a2 * y;
    const y2 = b0 * y + z1b;
    z1b = z2b - a1 * y2;
    z2b = b2 * y - a2 * y2;
    const _s = y2 * gainNorm * 4;
    bufL[i] += _s * panL; bufR[i] += _s * panR;
  }
  // Denormal guard on biquad states.
  if (Math.abs(z1a) < 1e-20) z1a = 0;
  if (Math.abs(z2a) < 1e-20) z2a = 0;
  if (Math.abs(z1b) < 1e-20) z1b = 0;
  if (Math.abs(z2b) < 1e-20) z2b = 0;
  v.voc1[0] = z1a; v.voc1[1] = z2a;
  v.voc2[0] = z1b; v.voc2[1] = z2b;
  v.vocEnv = env; v.gains[0] = env;
}

function _carrierKarplus(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const dampMod = Math.max(0, Math.min(1,
    (ctx.P.kpDamping || 0.4) + (v.centroid - 0.5) * 0.6));
  const fb = 0.9 + dampMod * 0.099;
  const lpBlend = dampMod * 0.6;
  const exciteAmt = ctx.P.kpExcite || 0.5;
  const kpBuf = v.kpBuf, kpLen = kpBuf.length;
  let idx = v.kpIdx, prev = v.kpPrev;
  if (voiceTarget >= 0.05 && v.kpGainPrev < 0.05) {
    for (let j = 0; j < kpLen; j++) kpBuf[j] += (_rng() * 2 - 1) * voiceTarget * 0.5;
  }
  v.kpGainPrev = voiceTarget;
  const contExcite = (1 - exciteAmt) * 0.4;
  const exFiltCoeff = 0.05 + v.centroid * 0.9;
  let exLp = v.kpExLp;
  const lpA = 0.5 + lpBlend * 0.5, lpB = 1 - lpA;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    if (voiceGain > 0.01) {
      const white = Math.random() * 2 - 1;
      exLp += (white - exLp) * exFiltCoeff;
      kpBuf[idx] += exLp * voiceGain * contExcite;
    }
    const out = kpBuf[idx];
    const filtered = (out * lpA + prev * lpB) * fb;
    prev = out;
    kpBuf[idx] = filtered;
    idx++; if (idx >= kpLen) idx = 0;
    const _s = out * Math.min(1, voiceGain * 3);
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  v.kpIdx = idx; v.kpPrev = prev; v.kpExLp = exLp; v.gains[0] = voiceGain;
}

function _carrierSine(v, ctx) {
  const phases = v.phases;
  const gains = v.gains;
  const targetGains = v.targetGains;
  const nk = phases.length;
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const smooth = ctx.smooth;
  const len = ctx.len;
  // Phases stored in table-index units [0, _SIN_N), not radians. dts is
  // the per-sample index increment; wrap threshold is _SIN_N. This lets
  // the inner loop call fsinFast (no modulos) instead of fsin.
  if (!v._sineDts || v._sineDts.length < nk) v._sineDts = new Float32Array(nk);
  const dts = v._sineDts;
  const baseInc = v.freq * ctx.invSr * _SIN_N;
  for (let k = 0; k < nk; k++) dts[k] = baseInc * (k + 1);
  for (let i = 0; i < len; i++) {
    let sample = 0;
    for (let k = 0; k < nk; k++) {
      gains[k] += (targetGains[k] - gains[k]) * smooth;
      if (gains[k] < 1e-6 && targetGains[k] < 1e-6) continue;
      sample += fsinFast(phases[k]) * gains[k];
      phases[k] += dts[k];
      if (phases[k] >= _SIN_N) phases[k] -= _SIN_N;
    }
    bufL[i] += sample * panL; bufR[i] += sample * panR;
  }
}

// Piano: modal synthesis with gain-edge attacks. Each voice has 12
// slightly-inharmonic partials. Rising edges in voiceGain inject
// strike energy into the per-partial peak amplitude; between strikes
// each partial decays exponentially at its own rate (low partials
// ring long, high partials die fast). Frequency-dependent decay
// scaling makes bass notes sustain longer than treble.
//
// Design notes in agent_docs/architecture-audio.md.
const _PIANO_K = 12;
const _PIANO_MIX = new Float32Array([1.0, 0.6, 0.38, 0.26, 0.20, 0.15, 0.11, 0.08, 0.055, 0.035, 0.022, 0.016]);
// Base decay rates (60dB-down time = 6.9/rate seconds at decayScale=1,
// freqDecayFactor=1). Lower index = longer ring.
const _PIANO_DECAY = new Float32Array([0.7, 0.95, 1.3, 1.7, 2.2, 2.8, 3.5, 4.3, 5.2, 6.3, 7.5, 9.0]);

function _carrierPiano(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  const voiceTarget = v.targetGains[0];
  let voiceGain = v.gains[0];
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  const invSr = ctx.invSr;
  const smooth = ctx.smooth;

  const decayScale = ctx.P.pnoDecay ?? 1.0;
  const brightness = ctx.P.pnoBrightness ?? 0.55;
  const stretch    = ctx.P.pnoStretch    ?? 0.5;

  const peaks  = v.pianoPeak;
  const phases = v.pianoPhases;
  const dts    = v.pianoDts;
  const decs   = v.pianoDecayPerSample;

  // Rebuild per-partial phase increments when freq or stretch changes.
  // Inharmonicity B is proportional to (261/f)^2 — bass gets more stretch.
  // dts and phases are stored in table-index space [0, _SIN_N) so the
  // inner loop can use fsinFast (no modulo).
  if (v.pianoDtsFreq !== v.freq || v.pianoDtsStretch !== stretch) {
    const B = stretch * 0.0005 * (261 / v.freq) * (261 / v.freq);
    const nyqIdx = _SIN_N * 0.5; // Nyquist in index units per sample
    for (let n = 0; n < _PIANO_K; n++) {
      const nn = n + 1;
      const fn = nn * v.freq * Math.sqrt(1 + B * nn * nn);
      const inc = fn * invSr * _SIN_N;
      dts[n] = inc < nyqIdx * 0.95 ? inc : 0;
    }
    v.pianoDtsFreq = v.freq;
    v.pianoDtsStretch = stretch;
  }

  // Per-partial decay factor (one-pole). Recomputed per block — cheap
  // (12 × Math.exp) and reacts to slider changes without extra wiring.
  const freqDecayFactor = Math.pow(261 / v.freq, 0.7);
  for (let n = 0; n < _PIANO_K; n++) {
    const rate = _PIANO_DECAY[n] / (decayScale * freqDecayFactor);
    decs[n] = Math.exp(-rate * invSr);
  }

  // Centroid → upper-partial brightness. Blue (high centroid) emphasises
  // partials 4+; red dampens them. Applied only to new strike energy.
  const centroidBoost = 1 + (v.centroid - 0.5) * 1.5;
  const velExpBase = 0.7 + brightness * 1.2;

  let prevGain = v.pianoPrevGain;
  const STRIKE_SCALE = 1.4;
  const OUT_SCALE = 3.0;

  for (let i = 0; i < len; i++) {
    voiceGain += (voiceTarget - voiceGain) * smooth;
    const gainRise = voiceGain - prevGain;
    prevGain = voiceGain;

    // Strike: accumulate energy into partial peaks during any rising edge.
    if (gainRise > 0) {
      const velBase = voiceGain + 0.05; // avoid 0^x
      for (let n = 0; n < _PIANO_K; n++) {
        if (dts[n] === 0) continue; // silenced (above Nyquist)
        const partialWeight = Math.pow(velBase, velExpBase * (1 + n * 0.08));
        const boost = n > 2 ? centroidBoost : 1;
        peaks[n] += _PIANO_MIX[n] * gainRise * partialWeight * boost * STRIKE_SCALE;
      }
    }

    // Sum output and apply decay.
    let sample = 0;
    for (let n = 0; n < _PIANO_K; n++) {
      peaks[n] *= decs[n];
      if (peaks[n] > 1e-6) sample += fsinFast(phases[n]) * peaks[n];
      phases[n] += dts[n];
      if (phases[n] >= _SIN_N) phases[n] -= _SIN_N;
    }
    sample *= OUT_SCALE;

    bufL[i] += sample * panL;
    bufR[i] += sample * panR;
  }

  // Denormal guard on per-partial peaks. Without this, silently-ringing
  // voices can spend blocks in subnormal arithmetic.
  for (let n = 0; n < _PIANO_K; n++) if (peaks[n] < 1e-20) peaks[n] = 0;
  v.pianoPrevGain = prevGain;
  v.gains[0] = voiceGain;
}

// Carrier dispatch table.
const _CARRIERS = {
  acid: _carrierAcid, fm: _carrierFM, supersaw: _carrierSupersaw,
  noise: _carrierNoise, pulse: _carrierPulse, vocoder: _carrierVocoder,
  karplus: _carrierKarplus, sine: _carrierSine, piano: _carrierPiano,
};

// Carriers that use a single gain band (gainK=1) vs sine's multi-partial.
const _SINGLE_BAND = { noise:1, acid:1, fm:1, supersaw:1, pulse:1, karplus:1, vocoder:1, piano:1 };

// Per-carrier gain smoothing time constants (seconds). Piano uses a
// moderately fast smoothing so attacks stay crisp without clicking.
const _SMOOTH_SEC = { karplus: 0.005, pulse: 0.03, acid: 0.04,
  noise: 0.06, fm: 0.06, supersaw: 0.06, vocoder: 0.06, piano: 0.015 };

// Freeverb (Jezar Wakefield) constants. Delay lengths are the tuned
// primes from the original C++ reference at 44.1 kHz; we use them as
// given — tonal character shifts slightly at other sample rates but
// this is the standard approach. Right-channel delays add a
// "stereo-spread" offset for decorrelation.
const _FV_COMB_LENS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const _FV_AP_LENS   = [556, 441, 341, 225];
const _FV_STEREO_SPREAD = 23;
const _FV_INPUT_GAIN = 0.015;      // input attenuation, prevents runaway in combs
const _FV_AP_FB      = 0.5;        // fixed allpass feedback per Jezar
const _FV_FB_OFFSET  = 0.28;       // roomSize=0 → comb feedback 0.28
const _FV_FB_SCALE   = 0.7;        // roomSize=1 → feedback 0.98
const _FV_DAMP_SCALE = 0.4;        // damping=1 → LP coef 0.4

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
    this.P = __PARAM_DEFAULTS__;
    // Freeverb reverb params (live in the same P namespace as carrier
    // params so the existing setParam/automation path works for them).
    if (this.P.reverbMix === undefined)     this.P.reverbMix = 0;
    if (this.P.reverbSize === undefined)    this.P.reverbSize = 0.5;
    if (this.P.reverbDamping === undefined) this.P.reverbDamping = 0.5;
    this._initReverb();
    // Stats postMessage is suppressed unless the main thread has asked
    // for it (typically when the stats window is open). Reduces
    // worklet → main thread traffic to zero during normal playback.
    this._statsEnabled = false;
    // Diagnostic accumulators — reset at each stats post. Timing
    // fields start null and stay null on platforms where
    // performance.now isn't available in the worklet scope, so the
    // UI can render "-" instead of a misleading 0.
    this._maxBlockMs = null;
    this._driftMs = null;
    this._maxSampleStep = 0;
    this._maxBoundaryStep = 0;
    this._maxD2 = 0;
    this._msgsThisBlockMax = 0;
    this._msgsAccum = 0;
    this._prevLastL = 0;
    this._wallStart = 0;
    this._audioStart = 0;
    // Cache performance reference once — avoids re-checking every block.
    this._perf = (typeof performance !== 'undefined' && performance.now) ? performance : null;
    this.port.onmessage = e => {
      // Count inbound messages to surface message-path pressure —
      // reported as "max messages between consecutive process() calls"
      // per stats window.
      this._msgsAccum = (this._msgsAccum | 0) + 1;
      const d = e.data;
      if (d.type === 'bins') {
        this.bins = d.bins;
      } else if (d.type === 'rebuild') {
        this._rebuild(d.freqs, d.binCount, d.sensorCount, d.fullScale);
      } else if (d.type === 'partials') {
        this.partials = d.value;
        this.P.partials = d.value;
        if (this.sensorCount > 0) this._rebuildPartials();
      } else if (d.type === 'statsEnabled') {
        this._statsEnabled = !!d.value;
        // When turning stats on, prime the counter so the next process()
        // block posts immediately (instead of waiting up to ~500 ms for
        // the threshold to build up). User expects to see stats the
        // moment the window opens.
        if (this._statsEnabled) this._processCount = 187;
      } else if (d.type === 'carrier') {
        // When switching to piano, align each voice's strike-edge
        // reference to its current smoothed gain. Otherwise the first
        // piano block sees gainRise = voiceGain - stale_pianoPrevGain
        // and injects a phantom strike proportional to whatever the
        // previous carrier's gain state was.
        if (d.value === 'piano' && this.voices) {
          for (const v of this.voices) {
            v.pianoPrevGain = v.gains[0] || 0;
          }
        }
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

  _initReverb() {
    this._rvCombL = []; this._rvCombR = [];
    this._rvApL   = []; this._rvApR   = [];
    this._rvCombLIdx = new Uint32Array(8);
    this._rvCombRIdx = new Uint32Array(8);
    this._rvCombLLp  = new Float32Array(8);
    this._rvCombRLp  = new Float32Array(8);
    this._rvApLIdx   = new Uint32Array(4);
    this._rvApRIdx   = new Uint32Array(4);
    for (let i = 0; i < 8; i++) {
      this._rvCombL.push(new Float32Array(_FV_COMB_LENS[i]));
      this._rvCombR.push(new Float32Array(_FV_COMB_LENS[i] + _FV_STEREO_SPREAD));
    }
    for (let i = 0; i < 4; i++) {
      this._rvApL.push(new Float32Array(_FV_AP_LENS[i]));
      this._rvApR.push(new Float32Array(_FV_AP_LENS[i] + _FV_STEREO_SPREAD));
    }
    // Smoothed wet mix — ramps to target over ~30 ms to avoid clicks
    // when reverb is toggled on/off during playback.
    this._rvWetSmooth = 0;
  }

  // Freeverb-style reverb applied in place over bufL/bufR for `len`
  // samples. Runs AFTER voice summation and BEFORE the master tanh
  // limiter so runaway comb resonance gets caught smoothly.
  _applyReverb(bufL, bufR, len) {
    const mixTarget = this.P.reverbMix ?? 0;
    // Fully bypass when both target and smoothed state are near zero —
    // no tail to render, no state to advance, free when disabled.
    if (mixTarget < 1e-4 && this._rvWetSmooth < 1e-4) return;

    const size = this.P.reverbSize ?? 0.5;
    const damp = this.P.reverbDamping ?? 0.5;
    const feedback = _FV_FB_OFFSET + size * _FV_FB_SCALE;
    const dampLP = damp * _FV_DAMP_SCALE;
    const ommDamp = 1 - dampLP;
    const wetSmoothCoef = 1 - Math.exp(-1 / (0.03 * sampleRate)); // ~30 ms ramp

    // Hoist state into locals for the inner loop.
    const combLs = this._rvCombL, combRs = this._rvCombR;
    const combLIdx = this._rvCombLIdx, combRIdx = this._rvCombRIdx;
    const combLLp = this._rvCombLLp, combRLp = this._rvCombRLp;
    const apLs = this._rvApL, apRs = this._rvApR;
    const apLIdx = this._rvApLIdx, apRIdx = this._rvApRIdx;
    let wet = this._rvWetSmooth;

    for (let i = 0; i < len; i++) {
      wet += (mixTarget - wet) * wetSmoothCoef;
      const dry = 1 - wet;
      const inL = bufL[i], inR = bufR[i];
      const mono = (inL + inR) * _FV_INPUT_GAIN;

      let outL = 0, outR = 0;

      // Eight parallel comb filters per channel, each with a 1-pole LP
      // in the feedback path (that's what "damping" does).
      for (let k = 0; k < 8; k++) {
        const bL = combLs[k];
        const iL = combLIdx[k];
        const yL = bL[iL];
        const lpL = yL * ommDamp + combLLp[k] * dampLP;
        combLLp[k] = lpL;
        bL[iL] = mono + lpL * feedback;
        combLIdx[k] = (iL + 1) % bL.length;
        outL += yL;

        const bR = combRs[k];
        const iR = combRIdx[k];
        const yR = bR[iR];
        const lpR = yR * ommDamp + combRLp[k] * dampLP;
        combRLp[k] = lpR;
        bR[iR] = mono + lpR * feedback;
        combRIdx[k] = (iR + 1) % bR.length;
        outR += yR;
      }

      // Four serial allpass filters per channel. Feedback is fixed.
      for (let k = 0; k < 4; k++) {
        const bL = apLs[k];
        const iL = apLIdx[k];
        const yL = bL[iL];
        bL[iL] = outL + yL * _FV_AP_FB;
        outL = -outL + yL;
        apLIdx[k] = (iL + 1) % bL.length;

        const bR = apRs[k];
        const iR = apRIdx[k];
        const yR = bR[iR];
        bR[iR] = outR + yR * _FV_AP_FB;
        outR = -outR + yR;
        apRIdx[k] = (iR + 1) % bR.length;
      }

      bufL[i] = dry * inL + wet * outL;
      bufR[i] = dry * inR + wet * outR;
    }

    // Denormal guard on comb LP states. Reverb states drift toward
    // 1e-38 during long silence and hit subnormal arithmetic.
    for (let k = 0; k < 8; k++) {
      if (Math.abs(combLLp[k]) < 1e-20) combLLp[k] = 0;
      if (Math.abs(combRLp[k]) < 1e-20) combRLp[k] = 0;
    }
    this._rvWetSmooth = wet;
  }
  _rebuildPartials() {
    this.voices = [];
    const nyq = sampleRate / 2;
    const freqs = this._freqs;
    if (!freqs) return;
    for (let i = 0; i < this.sensorCount; i++) {
      const f = freqs[i];
      // Count partials that fit under Nyquist, then allocate typed
      // arrays of exactly that length. Float32Array (vs plain `[]`)
      // gives stable element-kind on all JITs — particularly relevant
      // on Firefox Mobile — and halves state memory per partial.
      let nk = 0;
      for (let k = 1; k <= this.partials; k++) {
        if (f * k >= nyq) break;
        nk++;
      }
      const phases      = new Float32Array(nk);
      const gains       = new Float32Array(nk);
      const targetGains = new Float32Array(nk);
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
        voc1: new Float32Array(2), voc2: new Float32Array(2), // DF-IIT state [z1,z2] per biquad
        vocEnv: 0, vocPulsePhase: 0,
        // Piano: 12 modal partials. Peaks persist between blocks and
        // keep ringing after voiceGain drops, so the active-voice gate
        // in process() consults these too.
        pianoPhases: new Float32Array(12), pianoPeak: new Float32Array(12),
        pianoDts: new Float32Array(12), pianoDecayPerSample: new Float32Array(12),
        pianoDtsFreq: 0, pianoDtsStretch: -1, pianoPrevGain: 0,
        // Coast counter — see the active-voice gate in process().
        coast: 0 });
    }
  }
  process(inputs, outputs) {
    // Two independent diagnostic gates:
    //   _diag         — run signal-scan + message-rate accumulation
    //   _diagTiming   — additionally sample performance.now() (timing,
    //                   drift). Only set if the worklet scope exposes
    //                   performance (Firefox Mobile historically hasn't).
    const _diag = this._statsEnabled;
    const _diagTiming = _diag && this._perf !== null;
    const _t0 = _diagTiming ? this._perf.now() : 0;
    // Roll up message-path pressure: how many port.onmessage calls
    // landed between the previous process() and this one.
    if (_diag) {
      const mc = this._msgsAccum;
      this._msgsAccum = 0;
      if (mc > this._msgsThisBlockMax) this._msgsThisBlockMax = mc;
    } else {
      this._msgsAccum = 0;
    }

    const out = outputs[0];
    if (!out || !out[0] || this.voices.length === 0) return true;
    const bufL = out[0];
    const bufR = out[1] || out[0]; // fallback to mono if no R channel
    const len = bufL.length;
    const bins = this.bins;
    const K = this.partials;
    const bc = this.binCount;
    const sc = this.sensorCount;
    const isVocoder = this.carrier === 'vocoder';
    // Compute target gains from latest bins snapshot.
    // Normalize by fullScale (BASE_INTENSITY * sqrt(raysPer)) to recover
    // the 0-1 micGain scale, then apply floor + gamma. This matches the
    // input spectrum's absolute scaling so quiet voices stay quiet.
    // Noise and acid carriers use K=1 (single band per voice).
    if (bins && bins.length >= sc * bc) {
      const fs = this.fullScale;
      const gainK = (this.carrier in _SINGLE_BAND) ? 1 : K;
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
          // Normalise by max bin index (bc - 1). Guard bc >= 2 with
          // Math.max so a degenerate single-bin configuration doesn't
          // divide by zero and propagate NaN through the centroid.
          const rawCentroid = centroidDen > 1e-6
            ? centroidNum / (centroidDen * Math.max(1, bc - 1)) : 0.5;
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
    const smoothSec = _SMOOTH_SEC[this.carrier] ?? 0.08;
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
      const basePitch = 100;
      const pdt = basePitch * invSr;
      if (!this._vocPhase) this._vocPhase = 0;
      if (!this._vocExcBuf || this._vocExcBuf.length < len) this._vocExcBuf = new Float32Array(len);
      _vocExc = this._vocExcBuf;
      for (let i = 0; i < len; i++) {
        let exc = 0;
        if (useNoise) exc += (_rng() * 2 - 1) * noiseMix;
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
    // Shared context object passed to all carrier functions. Built once
    // per process() call; panL/panR updated per voice.
    // Reuse ctx object across calls — update properties, no allocation.
    if (!this._ctx) this._ctx = { bufL: null, bufR: null, len: 0, smooth: 0,
      centroidSmooth: 0, twoPi: 0, invSr: 0, sc: 0, P: null, vocExc: null,
      vocQ: 0, vocAtk: 0, vocRel: 0, panL: 0, panR: 0 };
    const ctx = this._ctx;
    ctx.bufL = bufL; ctx.bufR = bufR; ctx.len = len; ctx.smooth = smooth;
    ctx.centroidSmooth = centroidSmooth; ctx.twoPi = twoPi; ctx.invSr = invSr;
    ctx.sc = sc; ctx.P = this.P; ctx.vocExc = _vocExc;
    // Vocoder per-block constants: depend on sc and P only (not per voice).
    // vocQ is the unmodulated base; the carrier applies centroid-based
    // per-voice scaling on top. Avoids N_voices × 2×Math.exp per block.
    if (isVocoder) {
      const ratio = sc > 1 ? Math.pow(6000 / 80, 1 / sc) : 2;
      ctx.vocQ = Math.max(1, 1 / (ratio - 1));
      ctx.vocAtk = 1 - Math.exp(-1 / ((this.P.vocAttack ?? 5) * 0.001 * sampleRate));
      ctx.vocRel = 1 - Math.exp(-1 / ((this.P.vocRelease ?? 20) * 0.001 * sampleRate));
    }
    const _halfPi = Math.PI * 0.5;
    for (let s = 0; s < voiceCount; s++) {
      const pan = voiceCount > 1 ? s / (voiceCount - 1) : 0.5;
      ctx.panL = Math.cos(pan * _halfPi);
      ctx.panR = Math.sin(pan * _halfPi);
      const v = voices[s];
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      // Piano: partial peaks persist between blocks and keep ringing
      // after voiceGain drops — keep the voice running until they decay.
      if (!anyActive && this.carrier === 'piano' && v.pianoPeak) {
        for (let n = 0; n < 12; n++) {
          if (v.pianoPeak[n] > 1e-5) { anyActive = true; break; }
        }
      }
      // Coast: keep running the carrier for a few blocks after dropping
      // below the activity threshold. The per-sample gain smoothing
      // then pulls gains[k] continuously through ~0, instead of the
      // voice's output cliff-edging from "summed in" to "not summed in"
      // at a block boundary. Firefox Mobile's output resampler
      // specifically amplifies those cliffs into audible clicks.
      if (anyActive) v.coast = 3;
      else if (v.coast > 0) { v.coast--; anyActive = true; }
      if (!anyActive) {
        v.bp1 = 0; v.bp2 = 0; v.lp1 = 0; v.lp2 = 0; v.lp3 = 0; v.smoothCutoff = -1;
        if (v.voc1) { v.voc1[0] = v.voc1[1] = 0; }
        if (v.voc2) { v.voc2[0] = v.voc2[1] = 0; }
        v.vocEnv = 0;
        continue;
      }
      _activeCount++;

      const fn = _CARRIERS[this.carrier] || _carrierSine;
      fn(v, ctx);
    }
    this._lastActiveCount = _activeCount;
    // Freeverb (Jezar-style Schroeder): post-sum, pre-limiter. Fully
    // bypasses when reverbMix is 0 and the smoothed tail is empty.
    this._applyReverb(bufL, bufR, len);
    // Soft limiter on both channels.
    for (let i = 0; i < len; i++) { bufL[i] = ftanh(bufL[i]); bufR[i] = ftanh(bufR[i]); }

    // Diagnostic signal scan — only when stats are enabled. Scans the
    // post-limiter buffer for discontinuities; correlates with audible
    // clicks if they're generated inside the worklet. Skips scan
    // entirely when closed so CPU cost is zero during normal use.
    if (_diag) {
      let maxStep = this._maxSampleStep;
      let maxD2 = this._maxD2;
      // First-order step within the block.
      for (let i = 1; i < len; i++) {
        const s = Math.abs(bufL[i] - bufL[i - 1]);
        if (s > maxStep) maxStep = s;
      }
      // Second derivative (catches single-sample impulses that first-
      // order misses when the signal itself has high-frequency content).
      for (let i = 1; i < len - 1; i++) {
        const d2 = Math.abs(2 * bufL[i] - bufL[i - 1] - bufL[i + 1]);
        if (d2 > maxD2) maxD2 = d2;
      }
      // Block-boundary step: bufL[0] vs last sample of previous block.
      const bStep = Math.abs(bufL[0] - this._prevLastL);
      if (bStep > this._maxBoundaryStep) this._maxBoundaryStep = bStep;
      this._maxSampleStep = maxStep;
      this._maxD2 = maxD2;
    }
    this._prevLastL = bufL[len - 1];

    // Dropped-buffer detection: currentFrame should advance by exactly
    // 128 (render quantum) between calls. A gap > 128 = missed callback.
    if (this._prevFrame !== undefined) {
      const gap = currentFrame - this._prevFrame;
      if (gap > 128) this._droppedBuffers = (this._droppedBuffers || 0) + (gap / 128 - 1);
    }
    this._prevFrame = currentFrame;

    // Diagnostic timing close-out — wall-clock block duration + audio-
    // vs-wall drift. driftMs > 0 means the worklet is running slower
    // than real time (falling behind) even when whole quanta aren't
    // skipped. Only runs if performance.now() is available in this
    // worklet scope.
    if (_diagTiming) {
      const now = this._perf.now();
      const dt = now - _t0;
      if (this._maxBlockMs === null || dt > this._maxBlockMs) this._maxBlockMs = dt;
      if (this._wallStart === 0) {
        this._wallStart = now;
        this._audioStart = currentTime;
      } else {
        const wallElapsed = now - this._wallStart;
        const audioElapsed = (currentTime - this._audioStart) * 1000;
        this._driftMs = wallElapsed - audioElapsed;
      }
    } else if (this._wallStart !== 0) {
      // Reset drift reference when timing is disabled — otherwise the
      // next time stats opens we'd see a huge accumulated drift from
      // the offline period.
      this._wallStart = 0;
    }

    // Stats: report every ~500ms, but only when the main thread has
    // explicitly opted in (stats window open). When the window is
    // closed there is no worklet → main thread postMessage traffic.
    if (this._statsEnabled) {
      this._processCount = (this._processCount || 0) + 1;
      if (this._processCount >= 187) { // ~500ms at 48kHz/128 samples
        this.port.postMessage({
          type: 'stats',
          voices: this.voices.length,
          activeVoices: this._lastActiveCount || 0,
          carrier: this.carrier,
          blockSize: len,
          droppedBuffers: this._droppedBuffers || 0,
          // Diagnostics (reset each stats fire).
          maxBlockMs: this._maxBlockMs,
          driftMs: this._driftMs,
          maxSampleStep: this._maxSampleStep,
          maxBoundaryStep: this._maxBoundaryStep,
          maxD2: this._maxD2,
          msgsPerBlockMax: this._msgsThisBlockMax,
        });
        this._droppedBuffers = 0;
        // Reset timing fields to null so they remain distinguishable
        // from "measured zero" on platforms without performance.now().
        this._maxBlockMs = this._perf ? 0 : null;
        this._maxSampleStep = 0;
        this._maxBoundaryStep = 0;
        this._maxD2 = 0;
        this._msgsThisBlockMax = 0;
        this._processCount = 0;
      }
    }
    return true;
  }
}
registerProcessor('chromavox-synth', ChromavoxSynth);
