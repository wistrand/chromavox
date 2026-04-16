// Additive sensor synth. Each sensor is a voice at a log-spaced pitch; the
// voice's timbre comes from the sensor's incoming wavelength spectrum. The
// wavelength bins are grouped into K harmonic partials — low wavelengths
// feed the fundamental, high wavelengths feed upper harmonics — so the
// sound's brightness tracks the color mix reaching each sensor.

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
    for (const v of this.voices) {
      for (const h of v.harmonics) {
        try { h.osc.stop(); } catch {}
        h.gain.disconnect();
      }
    }
    this.voices = [];
    const K = 6; // partials per voice
    const loHz = 110, hiHz = 1800;
    const baseHz = this.baseHz ?? 130.81;
    const semi = Math.pow(2, 1 / 12);
    const nyquist = this.ctx.sampleRate / 2;
    for (let i = 0; i < sensorCount; i++) {
      let freq;
      if (this.mode === 'chromatic') {
        // Sensor i plays the same semitone the mic's bucket i covers — no
        // inversion, so in an identity scene input/output pitch line up.
        freq = baseHz * Math.pow(semi, i);
      } else {
        const t = sensorCount > 1 ? i / (sensorCount - 1) : 0;
        freq = loHz * Math.pow(hiHz / loHz, t);
      }
      const harmonics = [];
      for (let k = 1; k <= K; k++) {
        const f = freq * k;
        if (f >= nyquist) break;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(this.master);
        osc.start();
        harmonics.push({ osc, gain });
      }
      this.voices.push({ freq, harmonics });
    }
    this.count = sensorCount;
  }

  update(sensorBins, binCount, sensorCount) {
    if (!this.active) return;
    if (sensorCount !== this.count) this.rebuild(sensorCount);
    // Normalise so a bright scene doesn't clip; track max partial across frame.
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
        // Stash raw value in a scratch slot on the gain node to avoid a second
        // allocation; read back after the scale factor is known.
        voice.harmonics[k]._raw = avg;
      }
    }
    const scale = norm / maxPartial;
    for (let s = 0; s < sensorCount; s++) {
      const voice = this.voices[s];
      for (const h of voice.harmonics) {
        const v = Math.pow(Math.max(0, h._raw) * scale, 1.3);
        h.gain.gain.setTargetAtTime(v, now, 0.03);
      }
    }
  }

  disable() {
    if (!this.active) return;
    for (const v of this.voices) {
      for (const h of v.harmonics) {
        try { h.osc.stop(); } catch {}
        h.gain.disconnect();
      }
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
