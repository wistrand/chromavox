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

// Worklet source lives in synth-worklet.js (a real JS file for IDE
// support). Loaded via fetch, patched with PARAM_DEFAULTS, and
// turned into a Blob URL at enable() time.
export const WORKLET_FILE = 'js/synth-worklet.js';
export { PARAM_DEFAULTS };

// Legacy export for tests: set after first load.
export let _WORKLET_SRC = null;


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

  // Enable/disable periodic stats postMessages from the worklet.
  // Off by default; main.js flips it on when the stats window opens
  // and off when it closes — eliminates worklet → main thread traffic
  // during normal playback.
  setStatsEnabled(on) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'statsEnabled', value: !!on });
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
    // Re-entry guard. `this.active` only flips at the END of enable(),
    // after multiple awaits — so two concurrent calls (drop-handler
    // pre-warm + user click + visibility-resume, etc.) would both pass
    // the active check, both create AudioContexts, and both call
    // audioWorklet.addModule(). Firefox occasionally shares the
    // worklet global scope across rapidly-created contexts, in which
    // case registerProcessor('chromavox-synth') runs twice and throws
    // NotSupportedError. Reuse the in-flight Promise so concurrent
    // callers wait on the original instead of starting their own.
    if (this._enabling) return this._enabling;
    this._enabling = (async () => {
      try { await this._enableInner(sensorCount, mode); }
      finally { this._enabling = null; }
    })();
    return this._enabling;
  }

  async _enableInner(sensorCount, mode = 'log') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext not supported');
    // latencyHint: 'playback' asks the browser for a larger, more
    // forgiving output buffer — reduces sample-aligned glitches on
    // mobile (Firefox Android in particular) at the cost of a few
    // extra ms of output latency, which is fine for a synth whose
    // user input is the visual scene and not key velocity.
    this.ctx = new AC({ latencyHint: 'playback' });
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
    // Load worklet source from external file, patch PARAM_DEFAULTS, Blob URL.
    try {
      if (!_WORKLET_SRC) {
        const raw = await (await fetch(WORKLET_FILE)).text();
        _WORKLET_SRC = raw.replace('__PARAM_DEFAULTS__', JSON.stringify(PARAM_DEFAULTS));
      }
      const blob = new Blob([_WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      this.master?.disconnect();
      this.ctx?.close();
      this.ctx = null;
      this.master = null;
      throw err;
    }
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
    // Live audio path: worklet → master → destination.
    // The analyser is a passive tap off master (not in the live path).
    // Mobile Firefox has been observed to introduce glitches when an
    // analyser sits between the gain and the destination.
    this.workletNode.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.master.connect(this.analyser);
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
