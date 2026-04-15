// Microphone modulator. When active, sample() returns { volume, pitchHz }
// from the live audio stream. Volume is RMS in [0,1]; pitchHz is the
// dominant FFT bin frequency.

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
  }

  async enable() {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.6;
    src.connect(an);
    this.ctx = ctx;
    this.stream = stream;
    this.analyser = an;
    this.freqData = new Uint8Array(an.frequencyBinCount);
    this.timeData = new Float32Array(an.fftSize);
    this.active = true;
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.stream?.getTracks().forEach(t => t.stop());
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

// Downsample FFT magnitudes to `n` log-spaced buckets in [0,1].
export function micBands(mic, n) {
  if (!mic.active || !mic.freqData) return null;
  const fd = mic.freqData;
  const nyquist = mic.ctx.sampleRate / 2;
  const binCount = fd.length;
  const loHz = 80, hiHz = 6000;
  const out = new Float32Array(n);
  const logLo = Math.log(loHz), logHi = Math.log(hiHz);
  for (let i = 0; i < n; i++) {
    const f0 = Math.exp(logLo + (i / n) * (logHi - logLo));
    const f1 = Math.exp(logLo + ((i + 1) / n) * (logHi - logLo));
    const b0 = Math.max(1, Math.floor(f0 / nyquist * binCount));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * binCount));
    let sum = 0, cnt = 0;
    for (let b = b0; b < b1 && b < binCount; b++) { sum += fd[b]; cnt++; }
    // Subtract a noise floor so quiet buckets are truly zero, then apply a
    // gamma curve so the response ramps from zero rather than a faint glow.
    const raw = cnt ? (sum / cnt) / 255 : 0;
    const floor = 0.22;
    const v = Math.max(0, (raw - floor) / (1 - floor));
    out[i] = Math.pow(v, 1.5);
  }
  return out;
}
