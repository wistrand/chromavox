// Audio-input modulator. `enable(source)` attaches either the microphone or
// a synthetic debug source (sine, harmonics, white/pink noise) to the same
// AnalyserNode so everything downstream (sample, micBands) is oblivious to
// where the sound came from.

export class MicModulator {
  constructor() {
    this.active = false;
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.freqData = null;
    this.timeData = null;
    this.volume = 0;
    this.pitchHz = 0;
    this.nodes = [];
    this.source = 'mic';
    this.keyboardOctave = 4;
  }

  async enable(source = 'mic', deviceId = null) {
    if (this.active) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    an.smoothingTimeConstant = 0.6;

    let srcNode, stream = null;
    const nodes = [];

    if (source === 'mic') {
      const audio = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      srcNode = ctx.createMediaStreamSource(stream);
    } else if (source === 'sine') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 440;
      o.start();
      nodes.push(o);
      srcNode = o;
    } else if (source === 'harmonics') {
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      const base = 220;
      for (let k = 1; k <= 6; k++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = base * k;
        const gk = ctx.createGain();
        gk.gain.value = 1 / k;
        o.connect(gk).connect(mix);
        o.start();
        nodes.push(o, gk);
      }
      srcNode = mix;
    } else if (source === 'keyboard') {
      // ZXCVBNM bottom row + SDGHJ above = one-octave claviature. Comma/period
      // shift octaves. Multiple simultaneous keys → polyphony. Sawtooth voices
      // give some harmonic content so the wavelength-grouping synth sees variety.
      const mix = ctx.createGain();
      mix.gain.value = 0.35;
      const KEY_TO_SEMI = {
        KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5,
        KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
      };
      this.keyboardOctave = 4;
      const voices = new Map();
      const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
      const start = code => {
        if (voices.has(code)) return;
        const semi = KEY_TO_SEMI[code];
        if (semi === undefined) return;
        const midi = 12 * (this.keyboardOctave + 1) + semi;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToHz(midi);
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
        o.connect(g).connect(mix);
        o.start();
        voices.set(code, { o, g });
      };
      const stop = code => {
        const v = voices.get(code);
        if (!v) return;
        voices.delete(code);
        const t = ctx.currentTime;
        v.g.gain.setTargetAtTime(0, t, 0.03);
        setTimeout(() => { try { v.o.stop(); } catch {} v.g.disconnect(); }, 150);
      };
      const onDown = e => {
        if (e.repeat) return;
        if (e.code === 'Comma')  { this.keyboardOctave = Math.max(0, this.keyboardOctave - 1); return; }
        if (e.code === 'Period') { this.keyboardOctave = Math.min(8, this.keyboardOctave + 1); return; }
        if (KEY_TO_SEMI[e.code] !== undefined) { e.preventDefault(); start(e.code); }
      };
      const onUp = e => { if (KEY_TO_SEMI[e.code] !== undefined) stop(e.code); };
      window.addEventListener('keydown', onDown);
      window.addEventListener('keyup', onUp);
      this._kbdCleanup = () => {
        window.removeEventListener('keydown', onDown);
        window.removeEventListener('keyup', onUp);
        for (const v of voices.values()) { try { v.o.stop(); } catch {} }
        voices.clear();
      };
      nodes.push(mix);
      srcNode = mix;
    } else if (source === 'white' || source === 'pink') {
      const sr = ctx.sampleRate;
      const len = sr * 2;
      const buf = ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      if (source === 'white') {
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      } else {
        // Paul Kellet's pink noise approximation.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      }
      const bn = ctx.createBufferSource();
      bn.buffer = buf;
      bn.loop = true;
      bn.start();
      nodes.push(bn);
      srcNode = bn;
    } else {
      throw new Error('unknown mic source: ' + source);
    }

    srcNode.connect(an);
    this.ctx = ctx;
    this.stream = stream;
    this.analyser = an;
    this.nodes = nodes;
    this.source = source;
    this.freqData = new Uint8Array(an.frequencyBinCount);
    this.timeData = new Float32Array(an.fftSize);
    this.active = true;
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this._kbdCleanup?.();
    this._kbdCleanup = null;
    for (const n of this.nodes) { try { n.stop?.(); } catch {} }
    this.nodes = [];
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  sample() {
    if (!this.active) return null;
    const an = this.analyser;
    an.getByteFrequencyData(this.freqData);
    an.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    this.volume = Math.min(1, rms * 6);
    const nyquist = this.ctx.sampleRate / 2;
    const minBin = Math.max(1, Math.floor((80 / nyquist) * this.freqData.length));
    const maxBin = Math.min(this.freqData.length - 1, Math.ceil((4000 / nyquist) * this.freqData.length));
    let maxI = minBin, maxV = 0;
    for (let i = minBin; i <= maxBin; i++) {
      if (this.freqData[i] > maxV) { maxV = this.freqData[i]; maxI = i; }
    }
    this.pitchHz = maxV < 8 ? 0 : (maxI / this.freqData.length) * nyquist;
    return { volume: this.volume, pitchHz: this.pitchHz };
  }
}

// Map pitch (log-scale 100–1500 Hz) → wavelength. Kept narrow: 600→500nm
// so the color shift is perceptible but not a full rainbow sweep.
export function pitchToWavelength(hz) {
  const lo = 100, hi = 1500;
  if (hz <= 0) return 550;
  const t = Math.max(0, Math.min(1,
    (Math.log(Math.max(hz, 1)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return 600 - t * 100;
}

// Downsample FFT magnitudes to `n` buckets in [0,1].
// mode: 'log' (80–6000 Hz log-spaced) or 'chromatic' (semitone ladder from
// baseHz upward, ±50-cent window per bucket).
export function micBands(mic, n, mode = 'log', baseHz = 130.81) {
  if (!mic.active || !mic.freqData) return null;
  const fd = mic.freqData;
  const nyquist = mic.ctx.sampleRate / 2;
  const binCount = fd.length;
  const out = new Float32Array(n);
  const floor = 0.08;

  const shape = raw => {
    const v = Math.max(0, (raw - floor) / (1 - floor));
    return Math.pow(v, 1.2);
  };

  if (mode === 'chromatic') {
    const semi = Math.pow(2, 1 / 12);
    const half = Math.pow(2, 1 / 24);
    for (let i = 0; i < n; i++) {
      const fc = baseHz * Math.pow(semi, i);
      const f0 = fc / half, f1 = fc * half;
      const b0 = Math.max(1, Math.floor(f0 / nyquist * binCount));
      const b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * binCount));
      let sum = 0, cnt = 0;
      for (let b = b0; b < b1 && b < binCount; b++) { sum += fd[b]; cnt++; }
      out[i] = shape(cnt ? (sum / cnt) / 255 : 0);
    }
    return out;
  }

  const loHz = 80, hiHz = 6000;
  const logLo = Math.log(loHz), logHi = Math.log(hiHz);
  for (let i = 0; i < n; i++) {
    const f0 = Math.exp(logLo + (i / n) * (logHi - logLo));
    const f1 = Math.exp(logLo + ((i + 1) / n) * (logHi - logLo));
    const b0 = Math.max(1, Math.floor(f0 / nyquist * binCount));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * binCount));
    let sum = 0, cnt = 0;
    for (let b = b0; b < b1 && b < binCount; b++) { sum += fd[b]; cnt++; }
    out[i] = shape(cnt ? (sum / cnt) / 255 : 0);
  }
  return out;
}
