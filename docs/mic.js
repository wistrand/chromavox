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
    this.midiGain = 1.0;
  }

  setSmoothing(v) {
    this.smoothing = Math.max(0, Math.min(0.99, v));
    if (this.analyser) this.analyser.smoothingTimeConstant = this.smoothing;
  }

  async enable(source = 'mic', deviceId = null) {
    if (this.active) return;
    _peakHold = 0;

    // Sources that don't need an AudioContext — handle setup and
    // return early. The AudioContext is created below for audio sources.
    // Always set up touch/keys input so it works alongside any source.
    this._touchLevels = new Float32Array(64);
    this._installKeyboard();

    if (source === 'touch') {
      this.source = source;
      this.active = true;
      return;
    }

    if (source === 'midi') {
      this._midiNotes = new Map();    // note → velocity/pressure (0-1)
      this._mpeChToNote = new Map();  // MPE channel → note number
      this._mpeSlide = new Map();     // note → slide (0-1, center 0.5)
      this._mpeBend = new Map();      // note → pitch bend (-1 to +1)
      this._midiAccess = null;
      this._midiInput = null;
      const debugEl = typeof document !== 'undefined' ? document.getElementById('midi-debug') : null;
      const MAX_LOG = 40;
      const onMessage = e => {
        const bytes = [...e.data];
        const [status, note, vel] = bytes;
        if (status >= 0xF0) return;
        const cmd = status & 0xf0;
        const ch = status & 0x0f;
        if (cmd === 0x90 && vel > 0) {
          this._midiNotes.set(note, vel / 127);
          if (ch > 0) this._mpeChToNote.set(ch, note);
          // Remove from sustained set if re-struck while pedal is held.
          if (this._midiSustained) this._midiSustained.delete(note);
        } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
          if (this._midiSustainOn) {
            // Sustain pedal held: keep the note sounding, mark for
            // release when pedal lifts.
            if (!this._midiSustained) this._midiSustained = new Set();
            this._midiSustained.add(note);
          } else {
            this._midiNotes.delete(note);
          }
          this._mpeSlide.delete(note);
          this._mpeBend.delete(note);
          if (ch > 0) this._mpeChToNote.delete(ch);
        }
        // Sustain pedal (CC 64): hold notes after key release.
        if (cmd === 0xB0 && note === 64) {
          this._midiSustainOn = vel > 0;
          if (!this._midiSustainOn && this._midiSustained) {
            // Pedal released: clear all sustained notes.
            for (const n of this._midiSustained) {
              this._midiNotes.delete(n);
            }
            this._midiSustained.clear();
          }
        }
        // Channel Pressure (mono aftertouch 0xD0): update note levels.
        // MPE sends per-channel; non-MPE sends on ch 0 (all notes).
        if (cmd === 0xD0) {
          const pressure = note / 127; // byte 2 is pressure value
          if (ch > 0) {
            const n = this._mpeChToNote.get(ch);
            if (n !== undefined && this._midiNotes.has(n)) {
              this._midiNotes.set(n, pressure);
            }
          } else {
            for (const n of this._midiNotes.keys()) {
              this._midiNotes.set(n, pressure);
            }
          }
        }
        // Polyphonic Key Pressure (poly aftertouch 0xA0): per-note
        // pressure. Push 3 sends this in Poly Aftertouch expression
        // mode. Byte 2 = note number, byte 3 = pressure.
        if (cmd === 0xA0) {
          const pressure = vel / 127;
          if (this._midiNotes.has(note)) {
            this._midiNotes.set(note, pressure);
          }
        }
        // MPE slide (CC 74): per-note Y-axis position. Value 64 = center.
        // Map to per-note wavelength shift (0 = red-shifted, 1 = blue-shifted).
        if (cmd === 0xB0 && note === 74 && ch > 0) {
          const n = this._mpeChToNote.get(ch);
          if (n !== undefined) this._mpeSlide.set(n, vel / 127);
        }
        if (cmd === 0xB0 && this.onCC) {
          // Don't forward per-note CC 74 to the encoder handler.
          if (!(note === 74 && ch > 0)) this.onCC(note, vel);
        }
        // Pitch bend (0xE0). 14-bit: (vel << 7) | note. Center = 8192.
        if (cmd === 0xE0) {
          const bendRaw = ((vel & 0x7F) << 7) | (note & 0x7F);
          const bend = (bendRaw - 8192) / 8192; // -1 to +1
          if (ch > 0) {
            // MPE per-note bend.
            const n = this._mpeChToNote.get(ch);
            if (n !== undefined) this._mpeBend.set(n, bend);
          } else {
            // Global bend (ch 0): shift all emitters. Stored as a
            // single value; main.js applies it to wlPerSource.
            this._globalBend = bend;
          }
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
        let access;
        try { access = await navigator.requestMIDIAccess({ sysex: true }); }
        catch { access = await navigator.requestMIDIAccess(); }
        this._midiAccess = access;
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
    }

    // Audio sources: create AudioContext + AnalyserNode.
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();
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
    } else if (source === 'file') {
      // Audio file input. deviceId is an ArrayBuffer (first time) or
      // omitted (re-enable after disable). _decodedFile survives
      // disable() so the file can be resumed without re-picking.
      let audioData;
      if (deviceId) {
        audioData = await ctx.decodeAudioData(deviceId);
        this._decodedFile = audioData;
      } else if (this._decodedFile) {
        audioData = this._decodedFile;
      } else {
        throw new Error('No audio file provided');
      }
      this._fileBuffer = audioData;
      this._fileStartTime = ctx.currentTime;
      this._fileOffset = 0;
      this._filePlaying = true;
      const bn = ctx.createBufferSource();
      bn.buffer = audioData;
      bn.loop = true;
      bn.start(0, 0);
      nodes.push(bn);
      srcNode = bn;
      this._fileSource = bn;
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
    this.freqFloat = new Float32Array(an.frequencyBinCount);
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
  // Set a touch emitter level. Called by the UI on pointer events.
  _installKeyboard() {
    if (this._kbdCleanup) return; // already installed
    this.keyboardOctave = 0;
    const KEY_TO_DEG = {
      KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5,
      KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
    };
    this._kbdActiveDegs = new Set();
    const onDown = e => {
      if (e.repeat) return;
      if (e.code === 'Comma')  { this.keyboardOctave--; return; }
      if (e.code === 'Period') { this.keyboardOctave++; return; }
      const deg = KEY_TO_DEG[e.code];
      if (deg === undefined) return;
      if (e.target.matches('input, select, textarea')) return;
      e.preventDefault();
      const scale = SCALES[this.keyboardScale] || SCALES.chromatic;
      const idx = scale.length * this.keyboardOctave + deg;
      if (idx >= 0 && idx < 64) {
        this.setTouchLevel(idx, 1);
        this._kbdActiveDegs.add(e.code);
        if (this.onTouchChange) this.onTouchChange();
      }
    };
    const onUp = e => {
      const deg = KEY_TO_DEG[e.code];
      if (deg === undefined) return;
      this._kbdActiveDegs.delete(e.code);
      const scale = SCALES[this.keyboardScale] || SCALES.chromatic;
      const idx = scale.length * this.keyboardOctave + deg;
      if (idx >= 0 && idx < 64) {
        this.setTouchLevel(idx, 0);
        if (this.onTouchChange) this.onTouchChange();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    this._kbdCleanup = () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      this._kbdActiveDegs = null;
    };
  }

  setTouchLevel(emitterIdx, level) {
    // Touch input is always available regardless of source.
    // Store targets; actual levels ramp toward targets in smoothTouchLevels().
    if (!this._touchLevels) this._touchLevels = new Float32Array(64);
    if (!this._touchTargets) this._touchTargets = new Float32Array(64);
    if (emitterIdx >= 0 && emitterIdx < this._touchTargets.length) {
      this._touchTargets[emitterIdx] = level;
    }
  }

  // Ramp _touchLevels toward _touchTargets. Called once per frame from
  // the main loop. ~3ms attack, ~5ms release at 60fps (~16ms per frame).
  smoothTouchLevels() {
    if (!this._touchLevels || !this._touchTargets) return;
    const atkRate = 0.2;  // per-frame: reaches 87% in 3 frames (~50ms)
    const relRate = 0.15; // per-frame: reaches 87% in 4 frames (~66ms)
    for (let i = 0; i < this._touchLevels.length; i++) {
      const t = this._touchTargets[i];
      const c = this._touchLevels[i];
      if (Math.abs(t - c) < 0.001) {
        this._touchLevels[i] = t;
      } else {
        this._touchLevels[i] += (t - c) * (t > c ? atkRate : relRate);
      }
    }
  }

  // Build per-emitter wavelength overrides from MPE slide (CC 74).
  // Returns { min: Float32Array, max: Float32Array } or null if no MPE data.
  // Slide 0.5 = center = default wavelength range. Sliding up (→1) shifts
  // bluer, sliding down (→0) shifts redder. Range: ±100 nm offset.
  mpeWavelengths(n, wlMin, wlMax, padMapper) {
    if (!this._mpeSlide || this._mpeSlide.size === 0) return null;
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    const wlRange = wlMax - wlMin;
    const band = wlRange / n;
    // Default: evenly spaced wavelength bands.
    for (let i = 0; i < n; i++) {
      min[i] = wlMin;
      max[i] = wlMax;
    }
    let any = false;
    for (const [note, slide] of this._mpeSlide) {
      const idx = padMapper ? padMapper(note) : note;
      if (idx < 0 || idx >= n) continue;
      // Slide 0.5 = no shift. Range: ±100 nm.
      const offset = (slide - 0.5) * 200;
      min[idx] = Math.max(wlMin, Math.min(wlMax, wlMin + offset));
      max[idx] = Math.max(wlMin, Math.min(wlMax, wlMax + offset));
      any = true;
    }
    return any ? { min, max } : null;
  }

  // Get per-emitter pitch bend multiplier from MPE pitch bend.
  // Returns Float32Array of multipliers (1.0 = no bend) or null.
  // Push 3 MPE range is ±48 semitones. We use ±2 semitones for
  // subtle detuning (the full ±48 would be extreme).
  mpeBendMultipliers(n, padMapper) {
    if (!this._mpeBend || this._mpeBend.size === 0) return null;
    const mults = new Float32Array(n).fill(1);
    let any = false;
    for (const [note, bend] of this._mpeBend) {
      const idx = padMapper ? padMapper(note) : note;
      if (idx < 0 || idx >= n) continue;
      // ±2 semitones. bend is -1 to +1.
      mults[idx] = Math.pow(2, bend * 2 / 12);
      any = true;
    }
    return any ? mults : null;
  }

  directLevels(n, mode, baseHz, step) {
    // Touch: levels come directly from pointer events on the bench.
    if (this.source === 'touch') {
      if (!this._touchLevels) return new Float32Array(n);
      const levels = new Float32Array(n);
      for (let i = 0; i < n; i++) levels[i] = this._touchLevels[i] || 0;
      return levels;
    }
    // MIDI: column-first pad mapping so a vertical column of Push pads
    // = sequential emitters (matching the bench's vertical layout).
    if (this.source === 'midi') {
      if (!this._midiNotes) return new Float32Array(n);
      const levels = new Float32Array(n);
      for (const [note, vel] of this._midiNotes) {
        const idx = this._padMapper ? this._padMapper(note) : padNoteToEmitter(note);
        if (idx >= 0 && idx < n) levels[idx] = Math.max(levels[idx], Math.min(1, vel * this.midiGain));
      }
      return levels;
    }
    const freqs = this._knownFrequencies();
    if (!freqs) return null;
    const levels = new Float32Array(n);
    if (mode === 'log' || mode === 'voice') {
      const loHz = mode === 'voice' ? 100 : 80;
      const hiHz = mode === 'voice' ? 4000 : 6000;
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
      if (!this._kbdVoices || this._kbdVoices.size === 0) return [];
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
    if (this.source === 'midi' || this.source === 'touch') {
      // Return empty (not null) so directLevels returns an all-zeros
      // array and the FFT fallback never fires (no AudioContext).
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
    this._mpeChToNote = null;
    this._mpeSlide = null;
    this._mpeBend = null;
    this._globalBend = 0;
    this._midiSustainOn = false;
    this._midiSustained = null;
    this._touchLevels = null;
    this._touchTargets = null;
    this._fileSource = null;
    this._fileBuffer = null;
    this._filePlaying = false;
    this._fileOffset = 0;
    for (const n of this.nodes) { try { n.stop?.(); } catch {} }
    this.nodes = [];
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  // --- Audio file transport ---
  filePause() {
    if (this.source !== 'file' || !this._filePlaying || !this._fileSource) return;
    // Record current position within the buffer (modulo loop).
    const elapsed = this.ctx.currentTime - this._fileStartTime + this._fileOffset;
    this._fileOffset = elapsed % this._fileBuffer.duration;
    try { this._fileSource.stop(); } catch {}
    this._fileSource.disconnect();
    this._fileSource = null;
    this._filePlaying = false;
  }

  fileResume() {
    if (this.source !== 'file' || this._filePlaying || !this._fileBuffer) return;
    const bn = this.ctx.createBufferSource();
    bn.buffer = this._fileBuffer;
    bn.loop = true;
    bn.connect(this.analyser);
    bn.start(0, this._fileOffset);
    this._fileSource = bn;
    this._fileStartTime = this.ctx.currentTime;
    this._filePlaying = true;
  }

  fileRestart() {
    if (this.source !== 'file' || !this._fileBuffer) return;
    if (this._fileSource) {
      try { this._fileSource.stop(); } catch {}
      this._fileSource.disconnect();
    }
    this._fileOffset = 0;
    const bn = this.ctx.createBufferSource();
    bn.buffer = this._fileBuffer;
    bn.loop = true;
    bn.connect(this.analyser);
    bn.start(0, 0);
    this._fileSource = bn;
    this._fileStartTime = this.ctx.currentTime;
    this._filePlaying = true;
  }

  fileTime() {
    if (this.source !== 'file' || !this._fileBuffer) return 0;
    if (this._filePlaying) {
      return (this.ctx.currentTime - this._fileStartTime + this._fileOffset) % this._fileBuffer.duration;
    }
    return this._fileOffset;
  }

  fileDuration() {
    return this._fileBuffer ? this._fileBuffer.duration : 0;
  }

  sample() {
    if (!this.active) return null;
    if (this.source === 'midi') {
      this.volume = this._midiNotes && this._midiNotes.size > 0 ? 0.8 : 0;
      return true;
    }
    if (this.source === 'touch') {
      let any = false;
      if (this._touchLevels) for (let i = 0; i < this._touchLevels.length; i++) {
        if (this._touchLevels[i] > 0) { any = true; break; }
      }
      this.volume = any ? 0.8 : 0;
      return true;
    }
    const an = this.analyser;
    an.getByteFrequencyData(this.freqData);
    an.getFloatFrequencyData(this.freqFloat);
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
// Uses getFloatFrequencyData (dB) → linear magnitude → peak per bucket
// → steep gamma for sharp vocoder-like channel separation.
// mode: 'log' for 80–6000 Hz log-spaced; any other value is a scale name.
// Peak-hold for file source normalization — rises instantly, decays at
// ~0.95/frame (~1 s to half at 60 fps).
let _peakHold = 0;
const PEAK_DECAY = 0.95;

export function micBands(mic, n, mode = 'log', baseHz = 130.81, stepSemi = 1) {
  if (!mic.active || !mic.freqFloat) return null;
  const fd = mic.freqFloat;
  const nyquist = mic.ctx.sampleRate / 2;
  const binCount = fd.length;
  const out = new Float32Array(n);

  // Work in linear amplitude so dynamic range is preserved.
  const minDb = mic.analyser.minDecibels;   // default -100
  const maxDb = mic.analyser.maxDecibels;   // default -30
  const dbRange = maxDb - minDb;
  const dbToLin = db => db <= minDb ? 0 : Math.pow(10, db / 20);
  // dB-normalized 0-1 for absolute (non-file) sources.
  const dbNorm = db => Math.max(0, Math.min(1, (db - minDb) / dbRange));

  // File source uses peak-normalized linear; everything else uses the
  // original absolute dB mapping so silence looks quiet.
  const isFile = mic.source === 'file';

  const NOISE_GATE = 0.10;          // absolute dB-norm threshold
  const NOISE_GATE_LIN = 0.001;     // linear threshold for file

  let framePeak = 0;

  if (mode !== 'log' && mode !== 'voice') {
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
      let peak = 0;
      for (let b = b0; b < b1 && b < binCount; b++) {
        const v = isFile ? dbToLin(fd[b]) : dbNorm(fd[b]);
        if (v > peak) peak = v;
      }
      out[i] = peak;
      if (peak > framePeak) framePeak = peak;
    }
    // File: peak-normalized linear (relative spectral shape).
    // Non-file (mic, noise generators): absolute dB-normalized values
    // with a noise gate — silence stays silent, no peak normalization.
    if (isFile) {
      _peakHold = Math.max(framePeak, _peakHold * PEAK_DECAY);
      if (_peakHold < NOISE_GATE_LIN) return out.fill(0), out;
      const inv = 1 / _peakHold;
      for (let i = 0; i < n; i++) out[i] = out[i] * inv;
    } else {
      if (framePeak < NOISE_GATE) return out.fill(0), out;
      // Absolute values — floor at 0.20 to suppress ambient noise.
      for (let i = 0; i < n; i++) {
        out[i] = Math.max(0, (out[i] - 0.45) / 0.55);
      }
    }
    return out;
  }

  const loHz = mode === 'voice' ? 100 : 80;
  const hiHz = mode === 'voice' ? 4000 : 6000;
  const logLo = Math.log(loHz), logHi = Math.log(hiHz);
  for (let i = 0; i < n; i++) {
    const f0 = Math.exp(logLo + (i / n) * (logHi - logLo));
    const f1 = Math.exp(logLo + ((i + 1) / n) * (logHi - logLo));
    const b0 = Math.max(1, Math.floor(f0 / nyquist * binCount));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * binCount));
    let peak = 0;
    for (let b = b0; b < b1 && b < binCount; b++) {
      const v = isFile ? dbToLin(fd[b]) : dbNorm(fd[b]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > framePeak) framePeak = peak;
  }
  if (isFile) {
    _peakHold = Math.max(framePeak, _peakHold * PEAK_DECAY);
    if (_peakHold < NOISE_GATE_LIN) return out.fill(0), out;
    const inv = 1 / _peakHold;
    for (let i = 0; i < n; i++) out[i] = out[i] * inv;
  } else {
    if (framePeak < NOISE_GATE) return out.fill(0), out;
    for (let i = 0; i < n; i++) {
      out[i] = Math.max(0, (out[i] - 0.20) / 0.80);
    }
  }
  return out;
}
