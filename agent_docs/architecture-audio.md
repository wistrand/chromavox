# Architecture: Audio In / Out

## Audio in (`docs/mic.js`)

Toggle `Audio in` in the left panel. `mic-source` picks the signal
generator:

- `microphone` — real mic via `getUserMedia`. Browser AGC/AEC/NS are
  **off** (AGC flattens amplitude and makes the input look maxed-out).
  Device selectable via the Device dropdown (enumerated `audioinput`
  devices); defaults to the user-agent default.
- `sine 440` / `harmonics 220` — fixed oscillator tone(s) for testing.
- `white` / `pink` — broadband noise.
- `keyboard` — ZXCVBNM / SDGHJ bottom-row claviature, polyphonic
  sawtooth. `,` / `.` shift the base octave. Selecting this source
  auto-switches Mode to chromatic and pins Base to the current octave's
  C (synced to the Base dropdown when octave changes).

All sources feed a single `AnalyserNode` (`fftSize=8192`,
`smoothingTimeConstant=0.6`), so downstream code doesn't know where the
audio came from.

`micBands(mic, n, mode, baseHz, stepSemi)` bins the FFT into `n`
buckets:

- **log** mode: 80–6000 Hz log-spaced — good general coverage.
- **chromatic** mode: `stepSemi`-semitone ladder from `baseHz` upward,
  window half-a-step wide. Default `stepSemi = 1` (one semitone per
  bucket → total range `n` semitones); the **Span** slider widens this
  so N buckets can cover several octaves at lower pitch resolution.

Both modes apply a noise floor (0.08) and `γ=1.2` shaping so quiet
buckets read zero. Result is written to `scene.emitter.micLevels`. The
renderer draws an amber bar extending from each emitter tick
proportional to its bucket.

**Bucket color** additionally assigns each source a narrow wavelength
band (±12 nm around the source's linearly-mapped position across
400–700 nm) via `emitter.wlPerSource`, so different notes show as
different colors.

## Audio out (`docs/synth.js`)

`Audio out` toggles the additive synth (or press `Q`). Each sensor
drives one voice with **6 sine harmonics**.

- **Voice pitch** is the log-spaced or chromatic sensor-index frequency
  (same base and step as the mic side, so input and output ladders line
  up).
- **Timbre**: harmonic gains come from grouping the sensor's 64
  wavelength bins into 6 groups — so the timbre of each voice depends
  on which colors hit that sensor.
- Per-frame peak normalization across all partials caps loudness.
- Master gain slider (0–100%).
- Output device picker uses `AudioContext.setSinkId()` (Chromium ≥110 /
  recent Firefox). Older browsers silently fall back to the system
  default.

## Input/output symmetry

In chromatic mode, input bucket `i` and output voice `i` cover the same
pitch. In log mode, the same index `i` maps to roughly the same bucket
on both sides. This is intentional: under identity optics (no elements
placed), what you feed in should come back out at the same pitch.

## Design notes

The audio path is structurally a **vocoder-style spectral
resynthesizer**, not a transparent A→B pipeline. The input spectrum is
bucketed into N≈12 channels, mapped to N spatial positions, propagated
through the optical simulation, then resynthesized as N fixed-pitch
voices. In a clean (no-elements) scene the identity mapping is only
approximate; putting prisms, dichroics, or absorbers in the scene is
what makes the output differ meaningfully from the input.
