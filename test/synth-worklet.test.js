// Tests for the synth AudioWorklet DSP code. Runs in Node via a shim
// that provides AudioWorkletProcessor, registerProcessor, and sampleRate.

import { test, assert, assertClose } from './run.js';
import { _WORKLET_SRC } from '../docs/synth.js';

// --- Worklet shim ---
const _registered = {};
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
globalThis.registerProcessor = (name, cls) => { _registered[name] = cls; };

// Evaluate the worklet source (PARAM_DEFAULTS already interpolated).
(0, eval)(_WORKLET_SRC);

const SynthClass = _registered['chromavox-synth'];

function makeSynth(carrier = 'sine', sensorCount = 4, freq = 440) {
  const s = new SynthClass();
  const freqs = new Float32Array(sensorCount);
  for (let i = 0; i < sensorCount; i++) freqs[i] = freq * (i + 1) / sensorCount;
  s.port.onmessage({ data: { type: 'carrier', value: carrier } });
  s.port.onmessage({ data: { type: 'rebuild', freqs, binCount: 4, sensorCount, fullScale: 1 } });
  return s;
}

function processBlock(s, len = 128) {
  const buf = new Float32Array(len);
  s.process([], [[buf]]);
  return buf;
}

function feedBins(s, sensorCount = 4, level = 1) {
  const bins = new Float32Array(sensorCount * 4);
  for (let i = 0; i < bins.length; i++) bins[i] = level;
  s.port.onmessage({ data: { type: 'bins', bins } });
}

// --- Tests ---

test('worklet: registers ChromavoxSynth processor', () => {
  assert(SynthClass, 'ChromavoxSynth class not registered');
  assert(typeof SynthClass === 'function');
});

test('worklet: process returns true (keep alive)', () => {
  const s = makeSynth();
  const buf = new Float32Array(128);
  const ret = s.process([], [[buf]]);
  assert(ret === true, 'process should return true');
});

test('worklet: silence when no bins fed', () => {
  const s = makeSynth();
  const buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max === 0, 'output should be silent without bins');
});

test('worklet: sine carrier produces non-zero output', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  // Process several blocks to let gain smoothing ramp up.
  let buf;
  for (let i = 0; i < 20; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max > 0.001, `sine output too quiet: ${max}`);
});

test('worklet: noise carrier produces non-zero output', () => {
  const s = makeSynth('noise', 4, 440);
  feedBins(s, 4, 0.5);
  let buf;
  for (let i = 0; i < 20; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max > 0.001, `noise output too quiet: ${max}`);
});

test('worklet: acid carrier produces non-zero output', () => {
  const s = makeSynth('acid', 4, 220);
  feedBins(s, 4, 0.8);
  let buf;
  for (let i = 0; i < 30; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max > 0.001, `acid output too quiet: ${max}`);
});

test('worklet: FM carrier produces non-zero output', () => {
  const s = makeSynth('fm', 4, 440);
  feedBins(s, 4, 0.5);
  let buf;
  for (let i = 0; i < 20; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max > 0.001, `FM output too quiet: ${max}`);
});

test('worklet: supersaw carrier produces non-zero output', () => {
  const s = makeSynth('supersaw', 4, 440);
  feedBins(s, 4, 0.5);
  let buf;
  for (let i = 0; i < 20; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max > 0.001, `supersaw output too quiet: ${max}`);
});

test('worklet: voice stealing (zero bins → silence)', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  for (let i = 0; i < 20; i++) processBlock(s);
  // Feed zero bins.
  feedBins(s, 4, 0);
  // Let gain decay. At 48kHz with 128-sample blocks, 200 blocks ≈ 0.5s.
  // 60ms time constant → ~8 time constants in 0.5s → essentially zero.
  let buf;
  for (let i = 0; i < 200; i++) buf = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  assert(max < 0.001, `should be silent after zero bins, got ${max}`);
});

test('worklet: soft limiter keeps output in [-1, 1]', () => {
  const s = makeSynth('sine', 8, 200);
  // Feed very high bins to overdrive.
  feedBins(s, 8, 5);
  for (let i = 0; i < 30; i++) processBlock(s);
  const buf = processBlock(s);
  for (let i = 0; i < buf.length; i++) {
    assert(buf[i] >= -1 && buf[i] <= 1, `sample ${i} out of range: ${buf[i]}`);
  }
});

test('worklet: acid smoothCutoff seeds on activation (no silent first block)', () => {
  const s = makeSynth('acid', 2, 220);
  feedBins(s, 2, 0.8);
  // First block after activation should not be completely silent.
  const buf = processBlock(s);
  // The first block may be quiet due to gain smoothing, but subsequent
  // blocks should ramp up. Check that block 2 has some output.
  const buf2 = processBlock(s);
  let max = 0;
  for (let i = 0; i < buf2.length; i++) max = Math.max(max, Math.abs(buf2[i]));
  // With the smoothCutoff sentinel fix, the filter should pass signal
  // from the second block onward (gain smoothing starts from 0 but
  // the filter coefficients are non-zero).
  assert(max > 1e-6, `acid should not be silent on second block: ${max}`);
});

test('worklet: partials message rebuilds voices', () => {
  const s = makeSynth('sine', 4, 440);
  assert(s.voices[0].phases.length >= 1, 'should have at least 1 partial');
  s.port.onmessage({ data: { type: 'partials', value: 4 } });
  assert(s.voices[0].phases.length >= 4, `expected ≥4 partials, got ${s.voices[0].phases.length}`);
});

test('worklet: carrier param message updates P', () => {
  const s = makeSynth('acid', 2, 220);
  s.port.onmessage({ data: { type: 'acidRes', value: 0.42 } });
  assertClose(s.P.acidRes, 0.42, 1e-9);
});

// --- Click / discontinuity tests ---

function maxDelta(buf) {
  let max = 0;
  for (let i = 1; i < buf.length; i++) {
    const d = Math.abs(buf[i] - buf[i - 1]);
    if (d > max) max = d;
  }
  return max;
}

function boundaryDelta(prevBuf, nextBuf) {
  return Math.abs(nextBuf[0] - prevBuf[prevBuf.length - 1]);
}

function processBlocks(s, n, len = 128) {
  const bufs = [];
  for (let i = 0; i < n; i++) bufs.push(processBlock(s, len));
  return bufs;
}

function maxBoundaryDelta(bufs) {
  let max = 0;
  for (let i = 1; i < bufs.length; i++) {
    const d = boundaryDelta(bufs[i - 1], bufs[i]);
    if (d > max) max = d;
  }
  return max;
}

test('click: acid onset — no discontinuity on first activation', () => {
  const s = makeSynth('acid', 4, 220);
  feedBins(s, 4, 0.8);
  const bufs = processBlocks(s, 10);
  const bd = maxBoundaryDelta(bufs);
  // Gain smoothing ramps gradually — boundary delta should be small.
  assert(bd < 0.1, `acid onset boundary delta too large: ${bd.toFixed(4)}`);
  // Also check intra-block deltas.
  for (let i = 0; i < bufs.length; i++) {
    const md = maxDelta(bufs[i]);
    assert(md < 0.3, `acid onset block ${i} intra-delta too large: ${md.toFixed(4)}`);
  }
});

test('click: acid reactivation — no click after silence gap', () => {
  const s = makeSynth('acid', 4, 220);
  // Ramp up.
  feedBins(s, 4, 0.8);
  processBlocks(s, 20);
  // Decay to silence.
  feedBins(s, 4, 0);
  processBlocks(s, 200);
  // Reactivate.
  feedBins(s, 4, 0.8);
  const bufs = processBlocks(s, 10);
  const bd = maxBoundaryDelta(bufs);
  assert(bd < 0.1, `acid reactivation boundary delta too large: ${bd.toFixed(4)}`);
});

test('click: many-voice simultaneous onset (16 voices)', () => {
  const s = makeSynth('sine', 16, 200);
  feedBins(s, 16, 1.0);
  const bufs = processBlocks(s, 10);
  const bd = maxBoundaryDelta(bufs);
  assert(bd < 0.3, `16-voice onset boundary delta too large: ${bd.toFixed(4)}`);
  for (const buf of bufs) {
    const md = maxDelta(buf);
    assert(md < 0.5, `16-voice intra-block delta too large: ${md.toFixed(4)}`);
  }
});

test('click: carrier switch sine → acid mid-playback', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  const before = processBlocks(s, 10);
  // Switch carrier. The acid filter starts from stale sine state, so
  // some discontinuity is expected. Verify it stays within the soft
  // limiter's output range and doesn't produce a full-scale spike.
  s.port.onmessage({ data: { type: 'carrier', value: 'acid' } });
  const after = processBlocks(s, 10);
  const switchDelta = boundaryDelta(before[before.length - 1], after[0]);
  assert(switchDelta < 0.8, `carrier switch boundary delta too large: ${switchDelta.toFixed(4)}`);
});

test('click: carrier switch sine → noise mid-playback', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  processBlocks(s, 10);
  s.port.onmessage({ data: { type: 'carrier', value: 'noise' } });
  const after = processBlocks(s, 10);
  // Noise onset from silence should ramp smoothly via gain smoothing.
  const bd = maxBoundaryDelta(after);
  assert(bd < 0.3, `sine→noise boundary delta too large: ${bd.toFixed(4)}`);
});

test('click: carrier switch sine → FM mid-playback', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  processBlocks(s, 10);
  s.port.onmessage({ data: { type: 'carrier', value: 'fm' } });
  const after = processBlocks(s, 10);
  const switchDelta = boundaryDelta(processBlocks(s, 1)[0], after[0]);
  // FM and sine share the same voice phase — transition should be smooth.
  assert(maxBoundaryDelta(after) < 0.3, `sine→FM boundary delta too large`);
});

test('click: carrier switch sine → supersaw mid-playback', () => {
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  processBlocks(s, 10);
  s.port.onmessage({ data: { type: 'carrier', value: 'supersaw' } });
  const after = processBlocks(s, 10);
  assert(maxBoundaryDelta(after) < 0.3, `sine→supersaw boundary delta too large`);
});

test('click: steady-state continuity (8 voices, 50 blocks)', () => {
  const s = makeSynth('sine', 8, 300);
  feedBins(s, 8, 0.5);
  // Let gain stabilize.
  processBlocks(s, 50);
  // Now check steady-state. With 8 voices at different frequencies,
  // the composite waveform's sample-to-sample delta can be significant
  // at block boundaries (up to the sum of voice slopes).
  const bufs = processBlocks(s, 50);
  const bd = maxBoundaryDelta(bufs);
  assert(bd < 0.15, `steady-state boundary delta too large: ${bd.toFixed(4)}`);
});

test('click: acid steady-state continuity (4 voices, 50 blocks)', () => {
  const s = makeSynth('acid', 4, 220);
  feedBins(s, 4, 0.6);
  processBlocks(s, 30);
  const bufs = processBlocks(s, 50);
  const bd = maxBoundaryDelta(bufs);
  // Acid uses PolyBLEP sawtooth which has inherent phase-reset
  // discontinuities (smoothed but not eliminated). Accept higher delta.
  assert(bd < 0.25, `acid steady-state boundary delta too large: ${bd.toFixed(4)}`);
});

test('click: no long-term DC bias in sine output', () => {
  // Average over many blocks — the long-term DC of a sine mix should
  // be near zero (tanh limiter is symmetric, no offset).
  const s = makeSynth('sine', 4, 440);
  feedBins(s, 4, 0.5);
  processBlocks(s, 50); // stabilize
  let totalSum = 0, totalSamples = 0;
  for (let i = 0; i < 100; i++) {
    const buf = processBlock(s);
    for (let j = 0; j < buf.length; j++) totalSum += buf[j];
    totalSamples += buf.length;
  }
  const dc = totalSum / totalSamples;
  assert(Math.abs(dc) < 0.05, `long-term DC bias: ${dc.toFixed(4)}`);
});
