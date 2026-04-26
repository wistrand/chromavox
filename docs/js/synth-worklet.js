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

// Bandlimited saw wavetables. Replaces PolyBLEP saw in brass, bowed,
// supersaw, vocoder. PolyBLEP's 2-sample wrap correction has residual
// d2 artifacts (~0.1 amplitude) that read as click character through
// the bandpass filters in brass/bowed. A wavetable saw is constructed
// by summing N sines (Σ sin(h·θ)/h for h=1..N), which contains no
// discontinuity by construction — N is chosen per pitch band so the
// highest harmonic stays below Nyquist.
//
// Tables: 11 bands, 2048 samples each, harmonics doubling per band.
// Memory: 11 × 2048 × 4 = ~90 KB. Build cost: ~5 ms one-time.
const _SAW_TABLE_SIZE = 2048;
const _SAW_TABLE_MASK = _SAW_TABLE_SIZE - 1;
const _SAW_NUM_TABLES = 11;
const _SAW_HARMS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const _SAW_TABLES = new Array(_SAW_NUM_TABLES);
for (let t = 0; t < _SAW_NUM_TABLES; t++) {
  const maxH = _SAW_HARMS[t];
  const tbl = new Float32Array(_SAW_TABLE_SIZE);
  // Saw waveform: -2/π · Σ sin(h·θ)/h. Negative so it ramps up from -1
  // toward +1 across [0, 1) — same convention as 2*phase-1.
  for (let i = 0; i < _SAW_TABLE_SIZE; i++) {
    const theta = (i / _SAW_TABLE_SIZE) * 2 * Math.PI;
    let s = 0;
    for (let h = 1; h <= maxH; h++) s += Math.sin(h * theta) / h;
    tbl[i] = -s * 2 / Math.PI;
  }
  _SAW_TABLES[t] = tbl;
}
// Pick the table with the most harmonics whose highest harmonic stays
// below Nyquist · 0.95 at this voice's frequency. Called once per voice
// per block — cheap.
function _pickSawTable(freq) {
  if (freq < 1) return _SAW_NUM_TABLES - 1;
  const maxH = (sampleRate * 0.45) / freq;
  for (let t = _SAW_NUM_TABLES - 1; t > 0; t--) {
    if (_SAW_HARMS[t] <= maxH) return t;
  }
  return 0;
}
// Read a saw sample at `phase` ∈ [0, 1) from the chosen table with
// linear interpolation. Inlined manually in carriers for speed.

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
  // Varsaw formant shaping (Dittytoy/Oxygene trick): saw is multiplied
  // by a softclipped parabola of the phase, with formant strength
  // driven by the same envelope that opens the filter. Adds dynamic
  // odd harmonics that move *with* the envelope — perceived motion
  // without an explicit filter sweep. formantBase=0 disables (default).
  const formantBase = (ctx.P.acidFormant ?? 0) * 12;
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
    if (formantBase > 0) {
      const F = formantBase * (0.2 + voiceGain * 1.8);
      const x = phase;
      const fx = F * x * (1 - x);
      saw *= ftanh(fx);
    }
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

// Supersaw per-saw stereo spread. Center saw full in both channels;
// detuned pairs lean opposite channels. Amplitude-preserving so the
// summed channel level matches the mono mix (1/7 sum) — width comes
// from inter-channel decorrelation, not from gain splitting.
const _SS_PAN_L = new Float32Array([1.0, 1.0, 0.6, 1.0, 0.4, 1.0, 0.3]);
const _SS_PAN_R = new Float32Array([1.0, 0.6, 1.0, 0.4, 1.0, 0.3, 1.0]);

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
  // Bandlimited wavetable read replaces PolyBLEP. Highest detuned saw
  // determines the table choice (it has the broadest harmonic range).
  const tbl = _SAW_TABLES[_pickSawTable(baseFreq * c9)];
  const TS = _SAW_TABLE_SIZE;
  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    let sumL = 0, sumR = 0;
    for (let j = 0; j < 7; j++) {
      ph[j] += dts[j];
      if (ph[j] >= 1) ph[j] -= 1;
      const p = ph[j] * TS;
      const i0 = p | 0;
      const frac = p - i0;
      const a = tbl[i0], b = tbl[(i0 + 1) & _SAW_TABLE_MASK];
      const saw = a + (b - a) * frac;
      sumL += saw * _SS_PAN_L[j];
      sumR += saw * _SS_PAN_R[j];
    }
    const inv7 = (1/7) * voiceGain;
    const sL = sumL * inv7;
    const sR = sumR * inv7;
    ctx.bufL[i] += sL * ctx.panL; ctx.bufR[i] += sR * ctx.panR;
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
    // Two discontinuities per cycle:
    //   end-of-cycle wrap (phase 1→0): UP step (-1 → +1)
    //   duty crossing (phase duty-/+): DOWN step (+1 → -1)
    // Each side of each step needs its own PolyBLEP polarity:
    //   UP-step post-wrap: pulse at +1, smooth DOWN → SUBTRACT correction
    //   UP-step pre-wrap:  pulse at -1, smooth UP   → ADD correction
    //   DOWN-step post-duty: pulse at -1, smooth UP   → ADD correction
    //   DOWN-step pre-duty:  pulse at +1, smooth DOWN → SUBTRACT correction
    const t1 = phase / dt;
    if (t1 < 1) pulse += t1 + t1 - t1 * t1 - 1;          // post-wrap: -= (1-t1)² (smooth down)
    const t1b = (1 - phase) / dt;
    if (t1b < 1) pulse += t1b * t1b - t1b - t1b + 1;      // pre-wrap:  += (1-t1b)² (smooth up)
    const t2 = (phase - duty) / dt;
    if (t2 > 0 && t2 < 1) pulse -= t2 + t2 - t2 * t2 - 1; // post-duty: += (1-t2)² (smooth up)
    const t2b = (duty - phase) / dt;
    if (t2b > 0 && t2b < 1) pulse -= t2b * t2b - t2b - t2b + 1;  // pre-duty: -= (1-t2b)² (smooth down)
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

// Karplus body resonator constants. Two 2-pole bandpasses approximating
// a guitar's air (Helmholtz, ~110 Hz) and top-plate (~200 Hz) resonances.
// Computed once at module load — fixed regardless of voice frequency.
function _kpBodyCoefs(fHz, Q) {
  const w = 2 * Math.PI * fHz / sampleRate;
  const r = Math.max(0.5, Math.min(0.999, 1 - Math.PI * fHz / (Q * sampleRate)));
  return {
    c1: 2 * r * Math.cos(w),
    c2: -(r * r),
    norm: (1 - r * r) / 2,
  };
}
// Lower Q (wider bandpass) so the body contributes meaningful energy
// off-resonance instead of only at the exact peak. Q=8/6 gave ~0.001
// norm coefficients — body became inaudible for any note not landing
// near 110/200 Hz.
const _KP_BODY1 = _kpBodyCoefs(110, 3);  // air resonance, wide
const _KP_BODY2 = _kpBodyCoefs(200, 2.5); // top-plate fundamental, wide

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
  // Pluck excitation: short triangular noise burst (~5 ms, capped at
  // kpLen) deposited into the delay line at the current read position.
  // Replaces the previous "fill whole buffer with noise" approach
  // which sounded like filtered noise rather than a struck string for
  // the first cycle. Triangular envelope concentrates energy at the
  // start (sharp transient) and tapers off, matching a finger-string
  // contact. Stationary noise position simulates a fixed pluck point.
  if (voiceTarget >= 0.05 && v.kpGainPrev < 0.05) {
    const burstMs = 5;
    const burstLen = Math.min(kpLen, Math.floor(sampleRate * burstMs * 0.001));
    const peakAt = Math.max(1, burstLen >> 2); // peak at 25% of burst
    for (let s = 0; s < burstLen; s++) {
      // Triangle envelope: 0→1 over first peakAt samples, 1→0 after.
      const env = s < peakAt
        ? s / peakAt
        : 1 - (s - peakAt) / (burstLen - peakAt);
      const writeIdx = (idx + s) % kpLen;
      kpBuf[writeIdx] += (_rng() * 2 - 1) * voiceTarget * env;
    }
  }
  v.kpGainPrev = voiceTarget;
  // Continuous excitation reduced (was 0.4× weighting). Real plucked
  // strings don't sustain via re-energizing — the pluck transient
  // alone should ring out. Higher exciteAmt still adds breath/bow
  // character but the default leans toward clean pluck decay.
  const contExcite = (1 - exciteAmt) * 0.15;
  const exFiltCoeff = 0.05 + v.centroid * 0.9;
  let exLp = v.kpExLp;
  const lpA = 0.5 + lpBlend * 0.5, lpB = 1 - lpA;
  // Body resonator state. Lazy-init so existing voices upgrade cleanly.
  if (v.kpB1a === undefined) {
    v.kpB1a = 0; v.kpB1b = 0; v.kpB2a = 0; v.kpB2b = 0;
  }
  let b1a = v.kpB1a, b1b = v.kpB1b, b2a = v.kpB2a, b2b = v.kpB2b;
  const c1a = _KP_BODY1.c1, c2a = _KP_BODY1.c2, na = _KP_BODY1.norm;
  const c1b = _KP_BODY2.c1, c2b = _KP_BODY2.c2, nb = _KP_BODY2.norm;
  // Body mix: dry string × 1.0 + body resonators × 8.0 each.
  // The bandpass `norm = (1-r²)/2` is small (~0.025 at Q=3); body
  // contribution ≈ 0.2× input at center, weaker off-axis. 8.0× brings
  // the resonator response into a perceptually audible range without
  // dominating the dry string. Dry stays at full so overall loudness
  // matches the pre-body version.
  const dryMix = 1.0, bodyMix = 8.0;

  for (let i = 0; i < ctx.len; i++) {
    voiceGain += (voiceTarget - voiceGain) * ctx.smooth;
    if (voiceGain > 0.01 && contExcite > 0) {
      const white = Math.random() * 2 - 1;
      exLp += (white - exLp) * exFiltCoeff;
      kpBuf[idx] += exLp * voiceGain * contExcite;
    }
    const out = kpBuf[idx];
    const filtered = (out * lpA + prev * lpB) * fb;
    prev = out;
    kpBuf[idx] = filtered;
    idx++; if (idx >= kpLen) idx = 0;
    // Body resonators (2 parallel bandpasses) excited by string output.
    const y1 = out + c1a * b1a + c2a * b1b;
    const body1 = (y1 - b1b) * na;
    b1b = b1a; b1a = y1;
    const y2 = out + c1b * b2a + c2b * b2b;
    const body2 = (y2 - b2b) * nb;
    b2b = b2a; b2a = y2;
    const _s = (out * dryMix + (body1 + body2) * bodyMix) * Math.min(1, voiceGain * 3);
    ctx.bufL[i] += _s * ctx.panL; ctx.bufR[i] += _s * ctx.panR;
  }
  // Denormal flush on body state.
  if (Math.abs(b1a) < 1e-20) b1a = 0;
  if (Math.abs(b1b) < 1e-20) b1b = 0;
  if (Math.abs(b2a) < 1e-20) b2a = 0;
  if (Math.abs(b2b) < 1e-20) b2b = 0;
  v.kpIdx = idx; v.kpPrev = prev; v.kpExLp = exLp;
  v.kpB1a = b1a; v.kpB1b = b1b; v.kpB2a = b2a; v.kpB2b = b2b;
  v.gains[0] = voiceGain;
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
// Per-partial stereo spread. Fundamental full in both channels, upper
// partials lean L/R. Amplitude-preserving (not constant-power) so the
// visible waveform stays at mono level — width comes from decorrelation
// on the upper partials rather than splitting the fundamental.
const _PIANO_PAN_L = new Float32Array([1.0, 1.0, 0.6, 1.0, 0.5, 0.6, 1.0, 0.5, 1.0, 0.8, 0.6, 1.0]);
const _PIANO_PAN_R = new Float32Array([1.0, 0.6, 1.0, 0.5, 1.0, 1.0, 0.6, 1.0, 0.5, 0.8, 1.0, 0.6]);

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

    // Sum output and apply decay. Partials spread L/R for stereo width.
    let sampleL = 0, sampleR = 0;
    for (let n = 0; n < _PIANO_K; n++) {
      peaks[n] *= decs[n];
      if (peaks[n] > 1e-6) {
        const s = fsinFast(phases[n]) * peaks[n];
        sampleL += s * _PIANO_PAN_L[n];
        sampleR += s * _PIANO_PAN_R[n];
      }
      phases[n] += dts[n];
      if (phases[n] >= _SIN_N) phases[n] -= _SIN_N;
    }
    sampleL *= OUT_SCALE;
    sampleR *= OUT_SCALE;

    bufL[i] += sampleL * panL;
    bufR[i] += sampleR * panR;
  }

  // Denormal guard on per-partial peaks. Without this, silently-ringing
  // voices can spend blocks in subnormal arithmetic.
  for (let n = 0; n < _PIANO_K; n++) if (peaks[n] < 1e-20) peaks[n] = 0;
  v.pianoPrevGain = prevGain;
  v.gains[0] = voiceGain;
}

// --- Bell carrier ---
// Inharmonic struck-resonator: 5 partials at tubular-bell ratios with
// per-partial exponential decay (high partials decay faster). Sharp
// attack on rising voiceGain, no envelope smoothing — bells fire on
// strike. Same overall shape as _carrierPiano but with bell-specific
// ratios and decays, no inharmonicity stretching.
const _BELL_K = 5;
// Tubular-bell partial ratios (transverse-vibration modes). Real
// orchestral tubular bells: 1, 2.76, 5.40, 8.93, 13.34.
const _BELL_RATIO = new Float32Array([1.0, 2.76, 5.40, 8.93, 13.34]);
// Per-partial mix amplitude. Fundamental dominant; upper partials
// give the metallic "ring" but at reduced level so chords don't pile.
const _BELL_MIX   = new Float32Array([1.0, 0.55, 0.42, 0.30, 0.18]);
// Decay rate (60 dB-down time = 6.9 / rate seconds at decayScale=1).
// High partials decay much faster than the fundamental — that's what
// makes the attack bright but the tail a clean fundamental ring.
const _BELL_DECAY = new Float32Array([1.7, 2.8, 4.5, 7.0, 11.0]);
// Per-partial stereo spread. Fundamental fully centered (full
// amplitude in both channels), upper partials lean L/R. Amplitude-
// preserving rather than constant-power: keeps the visible waveform
// level identical to mono while still widening the image via
// inter-channel decorrelation on the upper partials.
const _BELL_PAN_L = new Float32Array([1.0, 1.0, 0.5, 1.0, 0.5]);
const _BELL_PAN_R = new Float32Array([1.0, 0.5, 1.0, 0.5, 1.0]);

function _carrierBell(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  const voiceTarget = v.targetGains[0];
  let voiceGain = v.gains[0];
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  const invSr = ctx.invSr;
  const smooth = ctx.smooth;

  const decayScale  = ctx.P.bellDecay      ?? 1.0;
  const brightness  = ctx.P.bellBrightness ?? 0.6;

  if (!v.bellPhases) {
    v.bellPhases = new Float32Array(_BELL_K);
    v.bellPeak   = new Float32Array(_BELL_K);
    v.bellDts    = new Float32Array(_BELL_K);
    v.bellDecs   = new Float32Array(_BELL_K);
    // Randomize initial phases so the first strike doesn't have all
    // partials pinned at sin(0)=0 → constructive beating in the first
    // few ms (was audible as a click on the first note of a voice).
    for (let n = 0; n < _BELL_K; n++) v.bellPhases[n] = Math.random() * _SIN_N;
    v.bellDtsFreq = 0;
    v.bellPrevGain = 0;
  }
  const phases = v.bellPhases;
  const peaks  = v.bellPeak;
  const dts    = v.bellDts;
  const decs   = v.bellDecs;

  // Rebuild phase increments on freq change. Stored in table-index
  // space so the inner loop can use fsinFast.
  if (v.bellDtsFreq !== v.freq) {
    const nyqIdx = _SIN_N * 0.5;
    for (let n = 0; n < _BELL_K; n++) {
      const inc = _BELL_RATIO[n] * v.freq * invSr * _SIN_N;
      dts[n] = inc < nyqIdx * 0.95 ? inc : 0; // silence partials above Nyquist
    }
    v.bellDtsFreq = v.freq;
  }

  // Per-partial decay coefficient (per-sample one-pole). Cheap to
  // recompute per block (5 × Math.exp).
  for (let n = 0; n < _BELL_K; n++) {
    const rate = _BELL_DECAY[n] / decayScale;
    decs[n] = Math.exp(-rate * invSr);
  }

  // Brightness shapes the upper-partial weight at strike. Capped so
  // partial 1 (mix=0.55) doesn't end up louder than the fundamental
  // (mix=1.0) — was creating a top-heavy strike that overdrove the
  // master limiter and clicked. Centroid still contributes (blue →
  // brighter strike, red → duller) but at half weight.
  const upperBoost = Math.min(0.6, brightness * 0.5 * (1 + (v.centroid - 0.5)));
  let prevGain = v.bellPrevGain;
  // Strike + output gains. With per-partial peak capped at the
  // partial's mix weight (sum of weights ≈ 2.9 for default brightness),
  // worst-case all-partials-aligned amplitude is ~2.9. Output scale
  // 0.35 gives single-voice peak ≈ 1.0 in the rare alignment case;
  // typical expected-amplitude-with-random-phase ≈ sqrt(K) * avg ≈ 1.2,
  // multiplied to ~0.4 — comfortably inside the limiter even with
  // several overlapping bell voices summing into the same channel.
  const STRIKE_SCALE = 0.6;
  const OUT_SCALE = 0.35;

  for (let i = 0; i < len; i++) {
    voiceGain += (voiceTarget - voiceGain) * smooth;
    const gainRise = voiceGain - prevGain;
    prevGain = voiceGain;

    if (gainRise > 0) {
      // Strike: inject energy into all partials, weighted by mix +
      // upper-partial boost on top of fundamental. Per-partial peak
      // is CAPPED to keep overlapping notes from accumulating without
      // bound — otherwise a sustained sweep injects strikes faster
      // than partials decay, peak grows past 1.0, the partial sum
      // saturates the master tanh limiter, and each strike clicks.
      // Cap at the partial's mix weight so a single full-velocity
      // strike on a quiet voice still fully energizes the bell, but
      // repeated/overlapping strikes can't pile beyond that.
      for (let n = 0; n < _BELL_K; n++) {
        if (dts[n] === 0) continue;
        const w = _BELL_MIX[n] * (n === 0 ? 1.0 : 1.0 + upperBoost);
        const cap = w; // ceiling for this partial's peak
        peaks[n] = Math.min(cap, peaks[n] + w * gainRise * STRIKE_SCALE);
      }
    }

    let sampleL = 0, sampleR = 0;
    for (let n = 0; n < _BELL_K; n++) {
      peaks[n] *= decs[n];
      if (peaks[n] > 1e-6) {
        const s = fsinFast(phases[n]) * peaks[n];
        sampleL += s * _BELL_PAN_L[n];
        sampleR += s * _BELL_PAN_R[n];
      }
      phases[n] += dts[n];
      if (phases[n] >= _SIN_N) phases[n] -= _SIN_N;
    }
    sampleL *= OUT_SCALE;
    sampleR *= OUT_SCALE;
    bufL[i] += sampleL * panL;
    bufR[i] += sampleR * panR;
  }

  for (let n = 0; n < _BELL_K; n++) if (peaks[n] < 1e-20) peaks[n] = 0;
  v.bellPrevGain = prevGain;
  v.gains[0] = voiceGain;
}

// --- Brass carrier ---
// PolyBLEP saw + 2-pole bandpass at a formant frequency (~1.4 kHz)
// + slight 5 Hz vibrato. The bandpass gives the saw a brass-section
// presence peak that distinguishes it from supersaw's pad-flat
// spectrum.
// Brass unison: 2 detuned saws panned L/R. Detune in CENTS, not
// semitones — ±5 cents (=10 cents total spread) is the chorus sweet
// spot. Larger values shift into "two notes" territory.
const _BRASS_DETUNE = Math.pow(2, 0.05 / 12); // ±5 cents ≈ 1.00289
const _BRASS_INV_DET = 1 / _BRASS_DETUNE;
// Inner unison pan: dominant voice full (1.0), opposite voice half (0.5).
// Amplitude-preserving — mono sum (saw + saw2) * 0.5 was the pre-stereo
// level; new per-channel mix (saw * 1.0 + saw2 * 0.5) etc. matches that
// scale within ~1 dB so the visible waveform doesn't shrink.
const _BRASS_UPAN_L = 1.0, _BRASS_UPAN_R = 0.5;

function _carrierBrass(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  const invSr = ctx.invSr;
  const smooth = ctx.smooth;

  if (v.brsBp1 === undefined) { v.brsBp1 = 0; v.brsBp2 = 0; v.brsVibPhase = 0; v.sawPhase2 = 0.5; }
  // Formant centre Hz; centroid pushes it up for brighter (blue)
  // input and down for darker (red).
  const formant = 700 + (ctx.P.brsFormant ?? 0.5) * 1800 * (1 + (v.centroid - 0.5));
  const fHz = Math.min(sampleRate * 0.45, Math.max(200, formant));
  // Q range tamed from 4–10 to 2–5: high-Q bandpass amplifies each
  // saw-wrap discontinuity ~4.5×, audible as click character on top of
  // the brass timbre. Lower Q gives a less honky but cleaner brass.
  const Q = 2 + (ctx.P.brsBite ?? 0.5) * 3;
  // 2-pole resonator coefficients (bandpass).
  const w = ctx.twoPi * fHz * invSr;
  const r = Math.max(0.9, Math.min(0.9999, 1 - Math.PI * fHz / (Q * sampleRate)));
  const c1 = 2 * r * Math.cos(w), c2 = -(r * r), norm = (1 - r * r) / 2;

  // Vibrato (5 Hz, ±0.3% pitch).
  const vibRate = 5 * ctx.twoPi * invSr;
  const vibDepth = 0.003;

  let phase = v.sawPhase;
  let phase2 = v.sawPhase2;
  let y1 = v.brsBp1, y2 = v.brsBp2;
  let vibPhase = v.brsVibPhase;
  // Bandlimited wavetable read. Pick table once per block based on the
  // higher-pitched unison voice (worst case for aliasing).
  const tbl = _SAW_TABLES[_pickSawTable(v.freq * _BRASS_DETUNE)];
  const TS = _SAW_TABLE_SIZE;
  for (let i = 0; i < len; i++) {
    voiceGain += (voiceTarget - voiceGain) * smooth;
    const vib = 1 + Math.sin(vibPhase) * vibDepth;
    vibPhase += vibRate; if (vibPhase > ctx.twoPi) vibPhase -= ctx.twoPi;
    const fBase = v.freq * vib;
    const dt = fBase * _BRASS_DETUNE * invSr;
    const dt2 = fBase * _BRASS_INV_DET * invSr;
    phase += dt;
    if (phase >= 1) phase -= 1;
    let p = phase * TS;
    let i0 = p | 0;
    const a1 = tbl[i0], b1 = tbl[(i0 + 1) & _SAW_TABLE_MASK];
    const saw = a1 + (b1 - a1) * (p - i0);
    phase2 += dt2;
    if (phase2 >= 1) phase2 -= 1;
    p = phase2 * TS;
    i0 = p | 0;
    const a2 = tbl[i0], b2 = tbl[(i0 + 1) & _SAW_TABLE_MASK];
    const saw2 = a2 + (b2 - a2) * (p - i0);
    // Sum unison voices into the bandpass (mono filter — cheaper and
    // the chorusing survives because the dry saw mix is per-channel).
    const sawSum = (saw + saw2) * 0.5;
    const y0 = sawSum + c1 * y1 + c2 * y2;
    const bp = (y0 - y2) * norm;
    y2 = y1; y1 = y0;
    // Stereo width comes from the dry mix: voice 1 leans L, voice 2 R.
    // Bandpass formant stays mono (centered). BP mix reduced from 4.5
    // to 2.0 to tame saw-wrap ringing through the bandpass.
    const dryL = saw * _BRASS_UPAN_L + saw2 * _BRASS_UPAN_R;
    const dryR = saw * _BRASS_UPAN_R + saw2 * _BRASS_UPAN_L;
    const sL = (dryL * 0.3 + bp * 2.0) * voiceGain;
    const sR = (dryR * 0.3 + bp * 2.0) * voiceGain;
    bufL[i] += sL * panL;
    bufR[i] += sR * panR;
  }
  if (Math.abs(y1) < 1e-20) y1 = 0;
  if (Math.abs(y2) < 1e-20) y2 = 0;
  v.sawPhase = phase; v.sawPhase2 = phase2;
  v.brsBp1 = y1; v.brsBp2 = y2; v.brsVibPhase = vibPhase;
  v.gains[0] = voiceGain;
}

// --- Bowed string carrier ---
// PolyBLEP saw + 1-pole lowpass (unity-gain at DC) + slow attack +
// light vibrato. The LP softens supersaw's edge; the slow gain
// smoothing (0.10s) gives a bow-stroke attack instead of struck.
// Bowed unison: 2 detuned saws panned L/R. Detune in CENTS — pads can
// take a bit more chorus than brass without sounding out of tune.
const _BOWED_DETUNE = Math.pow(2, 0.10 / 12); // ±10 cents ≈ 1.00579
const _BOWED_INV_DET = 1 / _BOWED_DETUNE;
// Same amplitude-preserving inner pan as brass — see _BRASS_UPAN_L note.
const _BOWED_UPAN_L = 1.0, _BOWED_UPAN_R = 0.5;

function _carrierBowed(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  let voiceGain = v.gains[0];
  const voiceTarget = v.targetGains[0];
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  const invSr = ctx.invSr;
  const smooth = ctx.smooth;

  if (v.bowLp1 === undefined) { v.bowLp1 = 0; v.bowLp2 = 0; v.bowVibPhase = 0; v.sawPhase2 = 0.5; }
  // 1-pole LP cutoff (centroid + slider). Unity gain at DC keeps
  // the carrier at parity with supersaw / acid output levels — the
  // 2-pole resonator I tried first had ~10× DC gain (1/(1-r)² with
  // r=0.7) and was perceived as far too loud.
  const cutoff = 1500 + (ctx.P.bowBright ?? 0.5) * 2500 * (1 + (v.centroid - 0.5));
  const fHz = Math.min(sampleRate * 0.45, Math.max(200, cutoff));
  // 1-pole LP coefficient. y[n] = α * x[n] + (1-α) * y[n-1].
  const alpha = 1 - Math.exp(-ctx.twoPi * fHz * invSr);
  const oneMinusAlpha = 1 - alpha;

  // Vibrato (5 Hz, ±1.2% pitch when slider at 1 — pronounced, since
  // visible vibrato is part of "bowed string" character).
  const vibRate = 5 * ctx.twoPi * invSr;
  const vibDepth = 0.012 * (ctx.P.bowVibrato ?? 0.5);

  let phase = v.sawPhase;
  let phase2 = v.sawPhase2;
  let lp = v.bowLp1;
  let lp2 = v.bowLp2;
  let vibPhase = v.bowVibPhase;
  // Bandlimited wavetable read replaces PolyBLEP — same pattern as brass.
  const tbl = _SAW_TABLES[_pickSawTable(v.freq * _BOWED_DETUNE)];
  const TS = _SAW_TABLE_SIZE;
  for (let i = 0; i < len; i++) {
    voiceGain += (voiceTarget - voiceGain) * smooth;
    const vib = 1 + Math.sin(vibPhase) * vibDepth;
    vibPhase += vibRate; if (vibPhase > ctx.twoPi) vibPhase -= ctx.twoPi;
    const fBase = v.freq * vib;
    const dt = fBase * _BOWED_DETUNE * invSr;
    const dt2 = fBase * _BOWED_INV_DET * invSr;
    phase += dt;
    if (phase >= 1) phase -= 1;
    let p = phase * TS;
    let i0 = p | 0;
    const a1 = tbl[i0], b1 = tbl[(i0 + 1) & _SAW_TABLE_MASK];
    const saw = a1 + (b1 - a1) * (p - i0);
    phase2 += dt2;
    if (phase2 >= 1) phase2 -= 1;
    p = phase2 * TS;
    i0 = p | 0;
    const a2 = tbl[i0], b2 = tbl[(i0 + 1) & _SAW_TABLE_MASK];
    const saw2 = a2 + (b2 - a2) * (p - i0);
    lp = alpha * saw + oneMinusAlpha * lp;
    lp2 = alpha * saw2 + oneMinusAlpha * lp2;
    // Stereo spread: each unison voice leans opposite channels.
    const sL = (lp * _BOWED_UPAN_L + lp2 * _BOWED_UPAN_R) * voiceGain;
    const sR = (lp * _BOWED_UPAN_R + lp2 * _BOWED_UPAN_L) * voiceGain;
    bufL[i] += sL * panL;
    bufR[i] += sR * panR;
  }
  if (Math.abs(lp) < 1e-20) lp = 0;
  if (Math.abs(lp2) < 1e-20) lp2 = 0;
  v.sawPhase = phase; v.sawPhase2 = phase2;
  v.bowLp1 = lp; v.bowLp2 = lp2; v.bowVibPhase = vibPhase;
  v.gains[0] = voiceGain;
}

// --- Tank drum carrier (Korg Minipops style) ---
// Pitched sine + brief pitch sweep + exponential body decay. The pitch
// sweep (start ~1.5× target, drop to target in ~30ms) gives the
// "tk-toomp" attack character of analog drum machines without
// distortion-noise spectrum pollution. Strike injects energy into a
// per-voice peak that decays exponentially per sample. Frequency
// determines drum "type" implicitly: low → kick, mid → tom, high → bongo.
function _carrierTankDrum(v, ctx) {
  v.centroid += (v.targetCentroid - v.centroid) * ctx.centroidSmooth;
  const voiceTarget = v.targetGains[0];
  let voiceGain = v.gains[0];
  const bufL = ctx.bufL, bufR = ctx.bufR;
  const panL = ctx.panL, panR = ctx.panR;
  const len = ctx.len;
  const invSr = ctx.invSr;
  const smooth = ctx.smooth;

  // Body decay rate scales inversely with frequency: low drums (kick)
  // ring longer than high drums (claves/bongos). Slider scales overall.
  const decayMul = ctx.P.tdDecay ?? 1.0;
  // 60-dB time at decayMul=1: ~0.4s @ 60Hz, ~0.10s @ 300Hz, ~0.04s @ 1.5kHz.
  const decayRate = (8 + v.freq * 0.025) / decayMul;
  const dec = Math.exp(-decayRate * invSr);
  // Pitch sweep: each strike sets sweep=1; sweep multiplier on phase
  // increment is (1 + sweep * sweepDepth). Decays at sweepRate to 0.
  const sweepDepth = 0.5 + (ctx.P.tdPunch ?? 0.5) * 1.5;
  const sweepRate = 50 + (ctx.P.tdPunch ?? 0.5) * 100; // 50-150 /sec
  const sweepDec = Math.exp(-sweepRate * invSr);

  if (v.tdPeak === undefined) {
    v.tdPeak = 0;
    v.tdPhase = Math.random() * _SIN_N;
    v.tdSweep = 0;
    v.tdPrevGain = 0;
  }
  let peak = v.tdPeak;
  let phase = v.tdPhase;
  let sweep = v.tdSweep;
  let prevGain = v.tdPrevGain;
  const baseInc = v.freq * invSr * _SIN_N;

  for (let i = 0; i < len; i++) {
    voiceGain += (voiceTarget - voiceGain) * smooth;
    const gainRise = voiceGain - prevGain;
    prevGain = voiceGain;
    if (gainRise > 0) {
      // Strike: inject peak energy; reset sweep to 1 (full pitch boost).
      // Cap peak so repeated strikes don't pile unbounded.
      peak = Math.min(1.0, peak + gainRise * 1.4);
      sweep = 1;
    }
    peak *= dec;
    sweep *= sweepDec;
    const inc = baseInc * (1 + sweep * sweepDepth);
    const s = fsinFast(phase) * peak;
    phase += inc;
    if (phase >= _SIN_N) phase -= _SIN_N;
    bufL[i] += s * panL;
    bufR[i] += s * panR;
  }
  if (peak < 1e-20) peak = 0;
  v.tdPeak = peak; v.tdPhase = phase; v.tdSweep = sweep; v.tdPrevGain = prevGain;
  v.gains[0] = voiceGain;
}

// Carrier dispatch table.
const _CARRIERS = {
  acid: _carrierAcid, fm: _carrierFM, supersaw: _carrierSupersaw,
  noise: _carrierNoise, pulse: _carrierPulse, vocoder: _carrierVocoder,
  karplus: _carrierKarplus, sine: _carrierSine, piano: _carrierPiano,
  bell: _carrierBell, brass: _carrierBrass, bowed: _carrierBowed,
  tankdrum: _carrierTankDrum,
};

// Index-keyed dispatch table. Order matches `Object.keys(CARRIERS)` in
// `carriers.js`: sine=0, noise=1, acid=2, fm=3, supersaw=4, pulse=5,
// vocoder=6, karplus=7, piano=8, bell=9, brass=10, bowed=11, tankdrum=12.
// Used by the per-(sensor, carrier) voice path; the per-voice carrierIdx
// field directly indexes this.
const _CARRIER_NAMES_BY_IDX = ['sine', 'noise', 'acid', 'fm', 'supersaw', 'pulse', 'vocoder', 'karplus', 'piano', 'bell', 'brass', 'bowed', 'tankdrum'];
const _CARRIERS_BY_IDX = _CARRIER_NAMES_BY_IDX.map(n => _CARRIERS[n]);
const _NAME_TO_IDX = {};
for (let i = 0; i < _CARRIER_NAMES_BY_IDX.length; i++) _NAME_TO_IDX[_CARRIER_NAMES_BY_IDX[i]] = i;
const _VOCODER_IDX = _NAME_TO_IDX.vocoder;
const _PIANO_IDX = _NAME_TO_IDX.piano;
const _SINE_IDX = _NAME_TO_IDX.sine;

// Carriers that use a single gain band (gainK=1) vs sine's multi-partial.
const _SINGLE_BAND = { noise:1, acid:1, fm:1, supersaw:1, pulse:1, karplus:1, vocoder:1, piano:1, bell:1, brass:1, bowed:1, tankdrum:1 };
// Index-keyed: 1 if the carrier uses a single gain band.
const _SINGLE_BAND_BY_IDX = _CARRIER_NAMES_BY_IDX.map(n => (n in _SINGLE_BAND) ? 1 : 0);

// Per-carrier gain smoothing time constants (seconds). Kept short on
// every carrier whose attack character matters — long smoothing low-passes
// transient brightness audibly. Bowed alone keeps a slow ramp because its
// attack character IS the bow stroke.
const _SMOOTH_SEC = { karplus: 0.002, pulse: 0.005, acid: 0.005,
  noise: 0.005, fm: 0.005, supersaw: 0.005, vocoder: 0.005, piano: 0.002,
  bell: 0.002, brass: 0.005, bowed: 0.10, sine: 0.005, tankdrum: 0.001 };
const _SMOOTH_SEC_BY_IDX = _CARRIER_NAMES_BY_IDX.map(n => _SMOOTH_SEC[n] ?? 0.08);

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
    this.carrierCount = 1;     // grows when runtime.carrierPerSource is set in scene
    this.fullScale = 1;
    this.sensorCount = 0;
    this.partials = 1;
    this.carrier = 'sine';      // global synth-carrier: used by voices with carrierIdx 0
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
        this._rebuild(d.freqs, d.binCount, d.sensorCount, d.fullScale, d.carrierCount);
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
        // previous carrier's gain state was. Only applies to voices
        // that actually follow the global carrier (carrierIdx === 0);
        // voices with a fixed carrierIdx > 0 are unaffected.
        if (d.value === 'piano' && this.voices) {
          for (const v of this.voices) {
            if ((v.carrierIdx | 0) === 0) v.pianoPrevGain = v.gains[0] || 0;
          }
        }
        this.carrier = d.value;
      } else if (d.type in this.P) {
        this.P[d.type] = d.value;
      }
    };
  }
  _rebuild(freqs, binCount, sensorCount, fullScale, carrierCount) {
    this.binCount = binCount;
    this.sensorCount = sensorCount;
    if (fullScale) this.fullScale = fullScale;
    if (carrierCount !== undefined) this.carrierCount = Math.max(1, carrierCount | 0);
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
    const cc = Math.max(1, this.carrierCount | 0);
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
      // Allocate one voice per (sensor, carrier) slot. carrierIdx 0 is
      // the "use the global synth-carrier" channel — voices for
      // emitters that didn't override default into this column. Slots
      // 1..cc-1 each play a fixed carrier from `_CARRIER_NAMES_BY_IDX`.
      // When `cc === 1`, the layout collapses to today's one-voice-
      // per-sensor (always carrierIdx 0 → global).
      const kpLen = Math.max(2, Math.ceil(sampleRate / f));
      for (let c = 0; c < cc; c++) {
        const phases      = new Float32Array(nk);
        const gains       = new Float32Array(nk);
        const targetGains = new Float32Array(nk);
        this.voices.push({ freq: f, carrierIdx: c, phases, gains, targetGains,
          bp1: 0, bp2: 0,
          sawPhase: 0, lp1: 0, lp2: 0, lp3: 0, smoothCutoff: -1,
          modPhase: 0,
          ssPhases: new Float32Array(7),
          centroid: 0.5, targetCentroid: 0.5,
          pulsePhase: 0,
          kpBuf: new Float32Array(kpLen), kpIdx: 0, kpPrev: 0, kpGainPrev: 0,
          kpExLp: 0,
          // Vocoder: 4th-order bandpass = two cascaded biquads.
          voc1: new Float32Array(2), voc2: new Float32Array(2),
          vocEnv: 0, vocPulsePhase: 0,
          // Piano: 12 modal partials.
          pianoPhases: new Float32Array(12), pianoPeak: new Float32Array(12),
          pianoDts: new Float32Array(12), pianoDecayPerSample: new Float32Array(12),
          pianoDtsFreq: 0, pianoDtsStretch: -1, pianoPrevGain: 0,
          coast: 0 });
      }
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
    const cc = Math.max(1, this.carrierCount | 0);
    // Resolve per-voice carrier index. carrierIdx 0 is the "use global
    // synth-carrier" channel — emitters without an override fall here
    // (Stage-0 plan invariant). Slots 1..cc-1 fix to a specific carrier.
    const globalIdx = _NAME_TO_IDX[this.carrier] ?? _SINE_IDX;
    const effectiveIdx = (vIdx) => {
      const ci = this.voices[vIdx].carrierIdx | 0;
      return ci === 0 ? globalIdx : ci;
    };
    // Compute target gains from latest bins snapshot. Wide bin layout:
    //   bins[s * bc * cc + c * bc + b]
    //   When cc === 1, this collapses to `s * bc + b` (legacy).
    // Each (s, c) voice draws from its own carrier slice. Per-voice
    // gainK depends on its carrier (sine multi-partial vs single band).
    const expectedBinsLen = sc * bc * cc;
    if (bins && bins.length >= expectedBinsLen) {
      const fs = this.fullScale;
      for (let vIdx = 0; vIdx < this.voices.length; vIdx++) {
        const v = this.voices[vIdx];
        const s = (vIdx / cc) | 0;
        const c = vIdx - s * cc;
        const eIdx = effectiveIdx(vIdx);
        const gainK = _SINGLE_BAND_BY_IDX[eIdx] ? 1 : K;
        const partialFS = fs / gainK;
        const voiceScale = 1 / Math.sqrt(sc * gainK);
        const singleBand = gainK === 1;
        const sensorBase = s * bc * cc + c * bc;
        const nk = v.targetGains.length;
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
            const val = bins[sensorBase + b];
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
          const rawCentroid = centroidDen > 1e-6
            ? centroidNum / (centroidDen * Math.max(1, bc - 1)) : 0.5;
          const wlCentroid = 1 - rawCentroid;
          const posCentroid = sc > 1 ? 1 - s / (sc - 1) : 0.5;
          const wlDeviation = Math.abs(wlCentroid - 0.575);
          const blend = Math.min(1, wlDeviation * 10);
          v.targetCentroid = wlCentroid * blend + posCentroid * (1 - blend);
        }
      }
    }
    // Synthesise.
    const twoPi = 2 * Math.PI;
    const invSr = 1 / sampleRate;
    for (let i = 0; i < len; i++) { bufL[i] = 0; bufR[i] = 0; }
    const voices = this.voices;
    const voiceCount = voices.length;
    let _activeCount = 0;

    // Detect whether any active voice will use the vocoder carrier
    // this block. The vocoder needs a shared excitation buffer; only
    // build it when at least one voice routes there. With per-voice
    // carriers, vocoder may be present even if `this.carrier !== 'vocoder'`.
    let _anyVocoder = false;
    for (let vIdx = 0; vIdx < voiceCount; vIdx++) {
      if (effectiveIdx(vIdx) === _VOCODER_IDX) { _anyVocoder = true; break; }
    }

    // Vocoder shared excitation: one broadband signal for all vocoder
    // voices. Pulse is a PolyBLEP saw at a fixed low pitch (100 Hz)
    // so all bandpass filters extract harmonics from the same rich
    // spectrum.
    let _vocExc = null;
    if (_anyVocoder) {
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
      // Bandlimited wavetable saw replaces PolyBLEP for vocoder excitation.
      const vocTbl = _SAW_TABLES[_pickSawTable(basePitch)];
      const TS = _SAW_TABLE_SIZE;
      for (let i = 0; i < len; i++) {
        let exc = 0;
        if (useNoise) exc += (_rng() * 2 - 1) * noiseMix;
        if (usePulse) {
          this._vocPhase += pdt;
          if (this._vocPhase >= 1) this._vocPhase -= 1;
          const p = this._vocPhase * TS;
          const i0 = p | 0;
          const a = vocTbl[i0], b = vocTbl[(i0 + 1) & _SAW_TABLE_MASK];
          const saw = a + (b - a) * (p - i0);
          exc += saw * pulseMix;
        }
        _vocExc[i] = exc;
      }
    }
    // Shared context object passed to all carrier functions. Built once
    // per process() call; per-voice fields (smooth, panL/panR) updated
    // inside the dispatch loop because each voice's effective carrier
    // determines its own smoothing time constant.
    // Reuse ctx object across calls — update properties, no allocation.
    if (!this._ctx) this._ctx = { bufL: null, bufR: null, len: 0, smooth: 0,
      centroidSmooth: 0, twoPi: 0, invSr: 0, sc: 0, P: null, vocExc: null,
      vocQ: 0, vocAtk: 0, vocRel: 0, panL: 0, panR: 0 };
    const ctx = this._ctx;
    ctx.bufL = bufL; ctx.bufR = bufR; ctx.len = len;
    ctx.twoPi = twoPi; ctx.invSr = invSr;
    ctx.sc = sc; ctx.P = this.P; ctx.vocExc = _vocExc;
    // Vocoder per-block constants: depend on sc and P only (not per voice).
    if (_anyVocoder) {
      const ratio = sc > 1 ? Math.pow(6000 / 80, 1 / sc) : 2;
      ctx.vocQ = Math.max(1, 1 / (ratio - 1));
      ctx.vocAtk = 1 - Math.exp(-1 / ((this.P.vocAttack ?? 5) * 0.001 * sampleRate));
      ctx.vocRel = 1 - Math.exp(-1 / ((this.P.vocRelease ?? 20) * 0.001 * sampleRate));
    }
    const _halfPi = Math.PI * 0.5;
    // Pan based on the SENSOR position (left→right across the bench),
    // not the voice index — otherwise carrierCount > 1 would interleave
    // pan positions. Each (s, c) voice at sensor s gets the same pan.
    // Stereo width: 0 = mono, 1 = full hard pan (sensor 0 left,
    // last sensor right). Default 0.5 = ±25% spread, low/high freq
    // visibly off-center but neither hard-panned. Hard pan (the
    // earlier 1.0 default) was musically extreme — bass + drums at
    // bottom emitters got pulled fully left, treble fully right.
    const PAN_WIDTH = 0.5;
    const panDen = sc > 1 ? sc - 1 : 1;
    for (let vIdx = 0; vIdx < voiceCount; vIdx++) {
      const s = (vIdx / cc) | 0;
      const v = voices[vIdx];
      const eIdx = effectiveIdx(vIdx);
      // Per-voice smoothing. Two rates: fast for attack (carrier-specific,
      // 2–10ms) and slow for release (30ms uniform). Release rate matters
      // because consecutive same-emitter notes were seeing voiceGain hit
      // floor + rise again with the same fast time constant — audible as
      // a click on each retrigger. With a 30ms release tail, the gain
      // envelope returns to silence smoothly instead of cliff-like, and
      // the next note's attack starts from a non-zero baseline.
      const smoothSec = _SMOOTH_SEC_BY_IDX[eIdx];
      const attackSmooth = 1 - Math.exp(-1 / (smoothSec * sampleRate));
      // Detect "release" state: any gains[k] > targetGains[k] means we're
      // currently sliding down toward silence (note has ended).
      let releasing = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.targetGains[k] < v.gains[k] - 1e-4) { releasing = true; break; }
      }
      // Bowed already has a slow attack (100ms) — its release shouldn't be
      // faster than its attack; fall through to attackSmooth.
      const releaseSmooth = smoothSec >= 0.030
        ? attackSmooth
        : 1 - Math.exp(-1 / (0.030 * sampleRate));
      const smooth = releasing ? releaseSmooth : attackSmooth;
      ctx.smooth = smooth;
      ctx.centroidSmooth = 1 - Math.pow(1 - smooth, len);
      const pan = sc > 1 ? 0.5 + (s / panDen - 0.5) * PAN_WIDTH : 0.5;
      ctx.panL = Math.cos(pan * _halfPi);
      ctx.panR = Math.sin(pan * _halfPi);
      let anyActive = false;
      for (let k = 0; k < v.gains.length; k++) {
        if (v.gains[k] > 1e-5 || v.targetGains[k] > 1e-5) { anyActive = true; break; }
      }
      // Piano: partial peaks persist between blocks and keep ringing
      // after voiceGain drops — keep the voice running until they decay.
      if (!anyActive && eIdx === _PIANO_IDX && v.pianoPeak) {
        for (let n = 0; n < 12; n++) {
          if (v.pianoPeak[n] > 1e-5) { anyActive = true; break; }
        }
      }
      // Same keep-alive for bell — without this, the voice deactivates
      // mid-ring (when voiceGain drops to 0 but bellPeak is still
      // sounding), the carrier stops being called, and the partial sum
      // cuts off abruptly mid-sample → cliff in the output buffer →
      // audible click. With the check, the bell tail decays naturally
      // through to silence.
      if (!anyActive && eIdx === _NAME_TO_IDX.bell && v.bellPeak) {
        for (let n = 0; n < 5; n++) {
          if (v.bellPeak[n] > 1e-5) { anyActive = true; break; }
        }
      }
      if (!anyActive && eIdx === _NAME_TO_IDX.tankdrum && v.tdPeak > 1e-5) {
        anyActive = true;
      }
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

      const fn = _CARRIERS_BY_IDX[eIdx] || _carrierSine;
      // Carrier-change crossfade: when this voice's effective carrier
      // differs from last block's, render the OLD carrier into a
      // scratch buffer at FULL output (normal smoothing, original
      // targets — no forced zero) and apply a LINEAR fade-out at
      // mix time. The new carrier renders from gains=0 into the real
      // buffer and ramps up via its own attack smoothing.
      //
      // Linear fade is critical: an exponential lerp toward 0 with
      // fast smooth (e.g., 0.3) drops the first sample by 30% of its
      // amplitude — that *is* the click. Linear weight w = 1 - i/len
      // gives a per-sample step of just 1/len = ~0.8%, inaudible.
      const prevEIdx = v.prevEIdx;
      if (prevEIdx !== undefined && prevEIdx !== eIdx && prevEIdx >= 0) {
        const oldFn = _CARRIERS_BY_IDX[prevEIdx];
        if (oldFn) {
          if (!ctx._scratchL || ctx._scratchL.length < len) {
            ctx._scratchL = new Float32Array(len);
            ctx._scratchR = new Float32Array(len);
          } else {
            ctx._scratchL.fill(0); ctx._scratchR.fill(0);
          }
          const realL = ctx.bufL, realR = ctx.bufR;
          // Snapshot gains so the new carrier starts cleanly. The old
          // carrier mutates gains[] during its render; we restore and
          // then zero them so the new carrier ramps up from silence.
          if (!v._savedGains || v._savedGains.length < v.gains.length) {
            v._savedGains = new Float32Array(v.gains.length);
          }
          const savedGains = v._savedGains;
          for (let k = 0; k < v.gains.length; k++) savedGains[k] = v.gains[k];
          ctx.bufL = ctx._scratchL; ctx.bufR = ctx._scratchR;
          oldFn(v, ctx);
          ctx.bufL = realL; ctx.bufR = realR;
          // Reset gains so the new carrier ramps up from silence via
          // its own smoothing. Linear fade-out on scratch handles the
          // continuity at sample 0.
          for (let k = 0; k < v.gains.length; k++) v.gains[k] = 0;
          // Reset resonant accumulators on the NEW carrier. Piano/bell/
          // tankdrum hold their output in a peak[] array that decays
          // ONLY when their carrier function runs. When the carrier was
          // swapped away for many blocks, peaks freeze at their last
          // value. On swap-back, the next call writes
          //   bufL[0] += sum(sin(phase) * peak) * OUT_SCALE
          // which is a stale-loud impulse independent of voiceGain —
          // the dominant source of boundary clicks in the audit. Zero
          // them so the new carrier starts cleanly.
          if (eIdx === _PIANO_IDX && v.pianoPeak) {
            for (let n = 0; n < _PIANO_K; n++) v.pianoPeak[n] = 0;
            v.pianoPrevGain = 0;
          }
          if (eIdx === _NAME_TO_IDX.bell && v.bellPeak) {
            for (let n = 0; n < _BELL_K; n++) v.bellPeak[n] = 0;
            v.bellPrevGain = 0;
          }
          if (eIdx === _NAME_TO_IDX.tankdrum && v.tdPeak !== undefined) {
            v.tdPeak = 0;
            v.tdSweep = 0;
            v.tdPrevGain = 0;
          }
        }
      }
      v.prevEIdx = eIdx;
      fn(v, ctx);
      // Mix the old-carrier scratch into the live buffer with a linear
      // fade-out (weight 1.0 at sample 0, 0.0 at sample len-1). Done
      // AFTER the new carrier renders so we preserve continuity:
      //   sample 0  = old_full * 1.0 + new_~0    ≈ continuous with prev block
      //   sample N-1 = old_~ * 0.0  + new_full   ≈ continuous with next block
      if (prevEIdx !== undefined && prevEIdx !== eIdx && prevEIdx >= 0
          && _CARRIERS_BY_IDX[prevEIdx]) {
        const sL = ctx._scratchL, sR = ctx._scratchR;
        const invLen = 1 / len;
        for (let i = 0; i < len; i++) {
          const w = 1 - i * invLen;
          ctx.bufL[i] += sL[i] * w;
          ctx.bufR[i] += sR[i] * w;
        }
      }
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
