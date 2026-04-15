// Additive sensor synth. Each sensor drives one sine oscillator at a
// log-spaced frequency; the oscillator's amplitude is the sensor's total
// intensity (sum across its wavelength bins). Top sensor = highest pitch.

export class SensorSynth {
  constructor() {
    this.active = false;
    this.ctx = null;
    this.master = null;
    this.voices = []; // { osc, gain }
    this.count = 0;
  }

  enable(sensorCount) {
    if (this.active) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.25;
    this.master.connect(this.ctx.destination);
    this.rebuild(sensorCount);
    this.active = true;
  }

  rebuild(sensorCount) {
    if (!this.ctx) return;
    for (const v of this.voices) {
      try { v.osc.stop(); } catch {}
      v.gain.disconnect();
    }
    this.voices = [];
    const loHz = 110, hiHz = 2200;
    for (let i = 0; i < sensorCount; i++) {
      const t = sensorCount > 1 ? i / (sensorCount - 1) : 0;
      // top of screen (i=0) → high pitch
      const freq = loHz * Math.pow(hiHz / loHz, 1 - t);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      this.voices.push({ osc, gain });
    }
    this.count = sensorCount;
  }

  update(sensorBins, binCount, sensorCount) {
    if (!this.active) return;
    if (sensorCount !== this.count) this.rebuild(sensorCount);
    let maxTotal = 1e-6;
    const totals = new Float32Array(sensorCount);
    for (let s = 0; s < sensorCount; s++) {
      let sum = 0;
      for (let b = 0; b < binCount; b++) sum += sensorBins[s * binCount + b];
      totals[s] = sum;
      if (sum > maxTotal) maxTotal = sum;
    }
    const norm = 1 / Math.sqrt(sensorCount);
    const now = this.ctx.currentTime;
    for (let s = 0; s < sensorCount; s++) {
      const v = Math.pow(totals[s] / maxTotal, 1.5) * norm;
      this.voices[s].gain.gain.setTargetAtTime(v, now, 0.03);
    }
  }

  disable() {
    if (!this.active) return;
    for (const v of this.voices) {
      try { v.osc.stop(); } catch {}
      v.gain.disconnect();
    }
    this.voices = [];
    this.master?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.active = false;
    this.count = 0;
  }
}
