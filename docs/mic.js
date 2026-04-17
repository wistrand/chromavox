// Audio-input modulator. `enable(source)` attaches either the microphone or
// a synthetic debug source (sine, harmonics, white/pink noise) to the same
// AnalyserNode so everything downstream (sample, micBands) is oblivious to
// where the sound came from.

import { scaleFreq, SCALES } from './spectrum.js';
import { padNoteToEmitter } from './push.js';

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
    this.keyboardOctave = 0;
    // Keyboard scale params — kept in sync by main.js so keyboard
    // voices match the currently selected input mode/base/span.
    this.keyboardScale = 'chromatic';
    this.keyboardBase = 261.63;
    this.keyboardStep = 1;
    this.smoothing = 0.6;
  }

  setSmoothing(v) {
    this.smoothing = Math.max(0, Math.min(0.99, v));
    if (this.analyser) this.analyser.smoothingTimeConstant = this.smoothing;
  }

  async enable(source = 'mic', deviceId = null) {
    if (this.active) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    an.smoothingTimeConstant = this.smoothing;

    let srcNode, stream = null;
    const nodes = [];

    if (source === 'mic') {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Microphone requires a secure context (HTTPS or localhost). ' +
          'Pick sine, harmonics, noise, or keyboard as the source instead.'
        );
      }
      // Disable browser AGC/AEC/NS so the analyser sees the raw envelope.
      // AGC in particular flattens loud and quiet to a constant level,
      // making the input look "stuck at max" no matter what you do.
      const constraints = {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      };
      if (deviceId) constraints.deviceId = { exact: deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
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
      // ZXCVBNM bottom row + SDGHJ above = 12-key claviature. Keys map
      // to sequential scale degrees (not chromatic semitones) so each
      // key lights exactly one emitter bucket in any mode. Comma/period
      // shift by one scale period (= one real octave). Sine voices for
      // zero harmonic bleed into adjacent buckets.
      const mix = ctx.createGain();
      mix.gain.value = 0.35;
      const KEY_TO_DEG = {
        KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5,
        KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
      };
      this.keyboardOctave = 0;
      const voices = new Map();
      const freqFor = deg => {
        const scale = SCALES[this.keyboardScale] || SCALES.chromatic;
        const offset = scale.length * this.keyboardOctave;
        return scaleFreq(this.keyboardBase, this.keyboardScale, offset + deg, this.keyboardStep);
      };
      const start = code => {
        if (voices.has(code)) return;
        const deg = KEY_TO_DEG[code];
        if (deg === undefined) return;
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = freqFor(deg);
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
        o.connect(g).connect(mix);
        o.start();
        voices.set(code, { o, g, deg });
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
        if (e.code === 'Comma')  { this.keyboardOctave--; this._retuneLiveVoices(voices, freqFor); return; }
        if (e.code === 'Period') { this.keyboardOctave++; this._retuneLiveVoices(voices, freqFor); return; }
        if (KEY_TO_DEG[e.code] !== undefined) { e.preventDefault(); start(e.code); }
      };
      const onUp = e => { if (KEY_TO_DEG[e.code] !== undefined) stop(e.code); };
      window.addEventListener('keydown', onDown);
      window.addEventListener('keyup', onUp);
      this._kbdVoices = voices;
      this._kbdFreqFor = freqFor;
      this._kbdCleanup = () => {
        window.removeEventListener('keydown', onDown);
        window.removeEventListener('keyup', onUp);
        for (const v of voices.values()) { try { v.o.stop(); } catch {} }
        voices.clear();
        this._kbdVoices = null;
        this._kbdFreqFor = null;
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
    } else if (source === 'midi') {
      // MIDI input — no AudioContext needed. Note-on/off events write
      // directly to _midiNotes; directLevels maps them to emitters.
      // Push-specific output (LED palette, pad colors) lives in push.js.
      this._midiNotes = new Map();
      this._midiAccess = null;
      this._midiInput = null;
      const debugEl = typeof document !== 'undefined' ? document.getElementById('midi-debug') : null;
      const MAX_LOG = 40;
      const onMessage = e => {
        const bytes = [...e.data];
        const [status, note, vel] = bytes;
        // Skip system-realtime messages (0xF0+): Active Sensing, Clock, etc.
        if (status >= 0xF0) return;
        const cmd = status & 0xf0;
        if (cmd === 0x90 && vel > 0) {
          this._midiNotes.set(note, vel / 127);
        } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
          this._midiNotes.delete(note);
        }
        if (cmd === 0xB0 && this.onCC) {
          this.onCC(note, vel);
        }
        if (debugEl) {
          const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
          const ch = (status & 0x0f) + 1;
          const names = { 0x80: 'off', 0x90: vel ? 'ON' : 'off', 0xa0: 'aft', 0xb0: 'CC', 0xc0: 'prg', 0xd0: 'chP', 0xe0: 'bend' };
          const label = names[cmd] || '???';
          const line = `${hex}  ch${ch} ${label} ${note ?? ''} ${vel ?? ''}`;
          const lines = debugEl.value ? debugEl.value.split('\n') : [];
          lines.push(line);
          if (lines.length > MAX_LOG) lines.splice(0, lines.length - MAX_LOG);
          debugEl.value = lines.join('\n');
          debugEl.scrollTop = debugEl.scrollHeight;
        }
      };
      try {
        // Request SysEx for Push palette (push.js). Fall back to basic.
        let access;
        try { access = await navigator.requestMIDIAccess({ sysex: true }); }
        catch { access = await navigator.requestMIDIAccess(); }
        this._midiAccess = access;
        // Prefer Push Live Port (User Port broken on Linux seq layer).
        let input = null;
        if (deviceId) input = access.inputs.get(deviceId);
        if (!input) {
          for (const inp of access.inputs.values()) {
            if (/live\s*port/i.test(inp.name)) { input = inp; break; }
          }
        }
        if (!input) {
          for (const inp of access.inputs.values()) { input = inp; break; }
        }
        if (input) { input.onmidimessage = onMessage; this._midiInput = input; }
        access.onstatechange = () => {
          if (this._midiInput && this._midiInput.state === 'disconnected') {
            this._midiInput = null;
            for (const inp of access.inputs.values()) {
              inp.onmidimessage = onMessage;
              this._midiInput = inp;
              break;
            }
          }
        };
      } catch (err) {
        throw new Error('MIDI access denied: ' + err.message);
      }
      this.source = source;
      this.active = true;
      return;
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

  // Build micLevels directly from known source frequencies, bypassing
  // the FFT. The FFT bin resolution (~23 Hz at 2048/48kHz) is coarser
  // than the gap between adjacent scale degrees (~15 Hz at C4), so
  // spectral leakage lights up neighboring emitters and causes audible
  // detuning on the synth side. For sources with known exact
  // frequencies (keyboard, sine, harmonics) we can set the correct
  // bucket directly.
  // Returns null for mic / noise sources (FFT is the right path there).
  directLevels(n, mode, baseHz, step) {
    // MIDI: column-first pad mapping so a vertical column of Push pads
    // = sequential emitters (matching the bench's vertical layout).
    if (this.source === 'midi') {
      if (!this._midiNotes) return new Float32Array(n);
      const levels = new Float32Array(n);
      for (const [note, vel] of this._midiNotes) {
        const idx = padNoteToEmitter(note);
        if (idx >= 0 && idx < n) levels[idx] = Math.max(levels[idx], vel);
      }
      return levels;
    }
    const freqs = this._knownFrequencies();
    if (!freqs) return null;
    const levels = new Float32Array(n);
    if (mode === 'log') {
      const loHz = 80, hiHz = 6000;
      const logLo = Math.log(loHz), logRange = Math.log(hiHz) - logLo;
      for (const { hz, amp } of freqs) {
        if (hz < loHz || hz > hiHz) continue;
        const t = (Math.log(hz) - logLo) / logRange;
        const idx = Math.round(t * (n - 1));
        if (idx >= 0 && idx < n) levels[idx] = Math.max(levels[idx], amp);
      }
    } else {
      for (const { hz, amp } of freqs) {
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < n; i++) {
          const fc = scaleFreq(baseHz, mode, i, step);
          const d = Math.abs(Math.log(hz) - Math.log(fc));
          if (d < bestDist) { bestDist = d; best = i; }
        }
        if (best >= 0 && bestDist < 0.5) levels[best] = Math.max(levels[best], amp);
      }
    }
    return levels;
  }

  // Return known exact frequencies for deterministic sources.
  _knownFrequencies() {
    if (this.source === 'keyboard') {
      if (!this._kbdVoices || this._kbdVoices.size === 0) return null;
      const scale = SCALES[this.keyboardScale] || SCALES.chromatic;
      const offset = scale.length * this.keyboardOctave;
      const out = [];
      for (const v of this._kbdVoices.values()) {
        const hz = scaleFreq(this.keyboardBase, this.keyboardScale, offset + v.deg, this.keyboardStep);
        out.push({ hz, amp: 1 });
      }
      return out;
    }
    if (this.source === 'sine') return [{ hz: 440, amp: 1 }];
    if (this.source === 'harmonics') {
      const out = [];
      for (let k = 1; k <= 6; k++) out.push({ hz: 220 * k, amp: 1 / k });
      return out;
    }
    if (this.source === 'midi') {
      // Return empty (not null) so directLevels returns an all-zeros
      // array and the FFT fallback never fires (MIDI has no AudioContext).
      return [];
    }
    return null;
  }

  // Update keyboard scale params and retune any held voices. Called by
  // main.js when mode / base / span changes.
  setKeyboardScale(scaleName, baseHz, step) {
    this.keyboardScale = scaleName;
    this.keyboardBase = baseHz;
    this.keyboardStep = step;
    if (this._kbdVoices && this._kbdFreqFor) {
      this._retuneLiveVoices(this._kbdVoices, this._kbdFreqFor);
    }
  }

  _retuneLiveVoices(voices, freqFor) {
    for (const v of voices.values()) {
      v.o.frequency.setTargetAtTime(freqFor(v.deg), this.ctx.currentTime, 0.01);
    }
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this._kbdCleanup?.();
    this._kbdCleanup = null;
    if (this._midiInput) { this._midiInput.onmidimessage = null; this._midiInput = null; }
    if (this._midiAccess) { this._midiAccess.onstatechange = null; this._midiAccess = null; }
    this._midiNotes = null;
    for (const n of this.nodes) { try { n.stop?.(); } catch {} }
    this.nodes = [];
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  sample() {
    if (!this.active) return null;
    if (this.source === 'midi') {
      this.volume = this._midiNotes && this._midiNotes.size > 0 ? 0.8 : 0;
      return true;
    }
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
// mode: 'log' for 80–6000 Hz log-spaced; any other value is a scale name
// (chromatic / major / minor / pentaMajor / pentaMinor / wholeTone / blues)
// — buckets walk that scale from baseHz upward with `stepSemi` degrees per
// bucket. Window is the geometric midpoint to neighboring buckets, so any
// scale gives full coverage with no overlap.
export function micBands(mic, n, mode = 'log', baseHz = 130.81, stepSemi = 1) {
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

  if (mode !== 'log') {
    const scaleName = mode;
    for (let i = 0; i < n; i++) {
      const fc = scaleFreq(baseHz, scaleName, i, stepSemi);
      const fcNext = scaleFreq(baseHz, scaleName, i + 1, stepSemi);
      const fcPrev = i > 0
        ? scaleFreq(baseHz, scaleName, i - 1, stepSemi)
        : (fc * fc / fcNext);
      const f0 = Math.sqrt(fcPrev * fc);
      const f1 = Math.sqrt(fc * fcNext);
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
