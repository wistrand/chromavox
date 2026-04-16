// Additive sensor synth. Each sensor is a voice at a log- or scale-spaced
// pitch; the voice's timbre comes from the sensor's incoming wavelength
// spectrum. The wavelength bins are grouped into K harmonic partials — low
// wavelengths feed the fundamental, high wavelengths feed upper harmonics —
// so the sound's brightness tracks the color mix reaching each sensor.

import { scaleFreq } from './spectrum.js';

// Per-voice DelayNode max time. Matches the tracer's MAX_DELAY hard cap.
// Fixed at construction (Web Audio constraint), so this is the absolute
// ceiling for echo length — anything longer is clamped.
const MAX_DELAY = 2.0;

export class SensorSynth {
  constructor() {
    this.active = false;
    this.ctx = null;
    this.master = null;
    this.voices = []; // { osc, gain }
    this.count = 0;
    this.volume = 0.25;
    this.mode = 'log';
    this.baseHz = 130.81;
    this.sinkId = '';
    this.stepSemi = 1;
    // Slow-decaying peak hold for amplitude normalization. Avoids zippering
    // when a ray sweeps across sensors and the instantaneous max jumps.
    this.peak = 1e-6;
    // Wet/dry mix for the per-voice delay tap. dry stays at 1; wet > 0
    // produces an audible echo proportional to that voice's mean delay.
    this.wet = 0.5;
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
    if (this.active && this.mode === 'chromatic') this.rebuild(this.count);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  enable(sensorCount, mode = 'log') {
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
    this.rebuild(sensorCount);
    this.active = true;
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.active) this.rebuild(this.count);
  }

  rebuild(sensorCount) {
    if (!this.ctx) return;
    this._teardownVoices();
    this.voices = [];
    const K = 6; // partials per voice
    const loHz = 110, hiHz = 1800;
    const baseHz = this.baseHz ?? 130.81;
    const stepDeg = this.stepSemi ?? 1;
    const scaleName = (this.mode && this.mode !== 'log') ? this.mode : 'chromatic';
    const nyquist = this.ctx.sampleRate / 2;
    for (let i = 0; i < sensorCount; i++) {
      let freq;
      if (this.mode !== 'log') {
        freq = scaleFreq(baseHz, scaleName, i, stepDeg);
      } else {
        const t = sensorCount > 1 ? i / (sensorCount - 1) : 0;
        freq = loHz * Math.pow(hiHz / loHz, t);
      }
      // Per-voice mixer + dry/wet split + DelayNode. Each harmonic feeds
      // the mixer; mixer splits to dry → master and wet → delay → master.
      const voiceMix = this.ctx.createGain();
      voiceMix.gain.value = 1;
      const dryGain = this.ctx.createGain();
      dryGain.gain.value = 1;
      const wetGain = this.ctx.createGain();
      wetGain.gain.value = this.wet;
      const delayNode = this.ctx.createDelay(MAX_DELAY);
      delayNode.delayTime.value = 0;
      voiceMix.connect(dryGain).connect(this.master);
      voiceMix.connect(wetGain).connect(delayNode).connect(this.master);
      const harmonics = [];
      for (let k = 1; k <= K; k++) {
        const f = freq * k;
        if (f >= nyquist) break;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(voiceMix);
        osc.start();
        harmonics.push({ osc, gain });
      }
      this.voices.push({ freq, harmonics, voiceMix, dryGain, wetGain, delayNode });
    }
    this.count = sensorCount;
  }

  _teardownVoices() {
    for (const v of this.voices) {
      for (const h of v.harmonics) {
        try { h.osc.stop(); } catch {}
        h.gain.disconnect();
      }
      v.voiceMix?.disconnect();
      v.dryGain?.disconnect();
      v.wetGain?.disconnect();
      v.delayNode?.disconnect();
    }
  }

  update(sensorBins, binCount, sensorCount, sensorDelay) {
    if (!this.active) return;
    if (sensorCount !== this.count) this.rebuild(sensorCount);
    let maxPartial = 1e-6;
    const now = this.ctx.currentTime;
    const norm = 1 / Math.sqrt(sensorCount);
    for (let s = 0; s < sensorCount; s++) {
      const voice = this.voices[s];
      const K = voice.harmonics.length;
      for (let k = 0; k < K; k++) {
        const b0 = Math.floor(k * binCount / K);
        const b1 = Math.floor((k + 1) * binCount / K);
        let sum = 0;
        for (let b = b0; b < b1; b++) sum += sensorBins[s * binCount + b];
        const avg = sum / Math.max(1, b1 - b0);
        if (avg > maxPartial) maxPartial = avg;
        voice.harmonics[k]._raw = avg;
      }
    }
    // Peak-hold with slow decay so the normalization scale doesn't snap
    // when a ray sweep momentarily quadruples the instantaneous max.
    this.peak = Math.max(maxPartial, this.peak * 0.94);
    const scale = norm / this.peak;
    for (let s = 0; s < sensorCount; s++) {
      const voice = this.voices[s];
      for (const h of voice.harmonics) {
        const v = Math.pow(Math.max(0, h._raw) * scale, 1.3);
        // Slightly longer time constant smooths transient spikes from rays
        // sweeping across sensor strips.
        h.gain.gain.setTargetAtTime(v, now, 0.06);
      }
      // Drive this voice's delay tap from the per-sensor mean arrival time.
      // Smoothing keeps voice → DelayNode parameter changes click-free.
      if (sensorDelay) {
        const d = Math.min(MAX_DELAY, Math.max(0, sensorDelay[s] || 0));
        voice.delayNode.delayTime.setTargetAtTime(d, now, 0.05);
      }
    }
  }

  disable() {
    if (!this.active) return;
    this._teardownVoices();
    this.voices = [];
    this.master?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.active = false;
    this.count = 0;
  }
}
