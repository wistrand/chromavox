# Architecture: Audio In / Out

## Audio in (`docs/mic.js`)

Toggle `Audio in` in the toolbar. `mic-source` picks the signal
generator:

- `microphone` — real mic via `getUserMedia`. Browser AGC / AEC / NS
  are disabled in the constraints object so the analyser sees the raw
  envelope (AGC flattens amplitude and makes input look maxed-out).
  Device selectable via the Device dropdown (enumerated `audioinput`
  devices); defaults to the user-agent default.
- `sine` / `harmonics` — fixed oscillator tone(s) for testing.
- `white` / `pink` — broadband noise generated from a looping noise
  buffer.
- `keyboard` — bottom-row claviature via keydown/keyup, polyphonic
  sawtooth. `,` / `.` shift the octave. Selecting this source
  auto-switches Mode to chromatic and pins Base to the current
  octave's C (synced with the Base dropdown when octave changes).

All sources feed a single `AnalyserNode` with `fftSize` and
`smoothingTimeConstant` set in `mic.js` `enable()`, so downstream code
doesn't know where the audio came from.

`micBands(mic, n, mode, baseHz, stepSemi)` bins the FFT into `n`
buckets:

- **log** mode: log-spaced across a broadband range (see the `loHz` /
  `hiHz` constants in `micBands`).
- **chromatic** mode: `stepSemi`-semitone ladder from `baseHz` upward,
  window half-a-step wide. The **Span** slider controls `stepSemi` —
  a wider step gives N buckets a broader total range at lower pitch
  resolution.

Both modes apply a noise floor and gamma shaping (see the `floor` and
`shape()` in `micBands`) so quiet buckets read zero. Result is written
to `scene.emitter.micLevels`. The renderer draws an amber bar
extending from each emitter tick proportional to its bucket.

**Bucket color** additionally assigns each source a narrow wavelength
band linearly mapped across the visible range via
`emitter.wlPerSource`, so different notes show as different colors.

## Audio out (`docs/synth.js`)

`Audio out` toggles the additive synth (or press `Q`). Each sensor
drives one voice with multiple sine partials (count is a constant in
`rebuild`).

- **Voice pitch** uses the same base and step as the mic side in
  chromatic mode, so input and output ladders line up. Log mode uses
  a separate configured range.
- **Timbre**: harmonic gains come from grouping the sensor's
  wavelength bins; per-voice timbre depends on which colors hit that
  sensor.
- Per-frame peak normalization across all partials caps loudness.
- Master gain slider drives `this.master.gain`.
- Output device picker uses `AudioContext.setSinkId()` where
  supported. Older browsers silently fall back to the system default.

## Input/output symmetry

In chromatic mode, input bucket `i` and output voice `i` cover the
same pitch. In log mode, the same index `i` maps to roughly the same
bucket on both sides. Under identity optics (no elements placed), what
you feed in comes back out at the same pitch.

## Design notes

The audio path is structurally a **vocoder-style spectral
resynthesizer**, not a transparent A→B pipeline. The input spectrum is
bucketed into a handful of channels, mapped to spatial positions,
propagated through the optical simulation, then resynthesized as
fixed-pitch voices. In a clean (no-elements) scene the identity
mapping is only approximate; putting prisms, dichroics, or absorbers
in the scene is what makes the output differ meaningfully from the
input.
