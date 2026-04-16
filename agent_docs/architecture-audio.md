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
  triangle wave (chosen so a single note mostly occupies one chromatic
  bucket; a sawtooth's harmonic stack would light several). `,` / `.`
  shift the octave. Selecting this source auto-switches Mode to
  chromatic and pins Base to the current octave's C (synced with the
  Base dropdown when octave changes).

All sources feed a single `AnalyserNode` with `fftSize` and
`smoothingTimeConstant` set in `mic.js` `enable()`, so downstream code
doesn't know where the audio came from.

`micBands(mic, n, mode, baseHz, stepSemi)` bins the FFT into `n`
buckets:

- **`log`** mode: log-spaced across a broadband range (see the `loHz`
  / `hiHz` constants in `micBands`).
- **scale modes** (`chromatic`, `major`, `minor`, `pentaMajor`,
  `pentaMinor`, `wholeTone`, `blues`): the mode value is the scale
  name; `scaleFreq(base, scaleName, i, stepSemi)` in `spectrum.js`
  walks the scale from `baseHz` upward, wrapping into higher octaves
  past the last degree. Window is the geometric midpoint to the
  previous and next scale degree — full coverage with no gaps or
  overlap regardless of how sparse the scale is.

The **Span** slider controls `stepSemi`, interpreted as
*scale-degrees per bucket*. With chromatic + span 2 you get whole
tones; with major + span 2 you get thirds. Span only matters in scale
modes (hidden in `log`).

The mic smoothing slider drives `AnalyserNode.smoothingTimeConstant`
via `mic.setSmoothing(v)`. Lower for snappier per-key response on the
keyboard claviature; higher for smoother envelope tracking on vocals
or sustained sources.

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
- **Slow-decaying peak hold** normalizes per-partial amplitude across
  frames (`this.peak = max(currentMax, this.peak * decay)`) so a ray
  briefly sweeping across a sensor doesn't snap the global scale and
  zipper unrelated voices.
- Voice-gain transitions use `setTargetAtTime` with a longer time
  constant for the same reason — soft response to single-frame spikes.
- Master gain slider drives `this.master.gain`.
- Output device picker uses `AudioContext.setSinkId()` where
  supported. Older browsers silently fall back to the system default.
- **Per-voice delay**: each voice has a `voiceMix → dryGain → master`
  path plus a parallel `voiceMix → wetGain → DelayNode → master` tap.
  `delayNode.delayTime` tracks `tracer.sensorDelay[s]` (the
  amplitude-weighted mean ray-arrival time at sensor `s`) via
  `setTargetAtTime`. Echoes the resynth voice, not the live mic input
  — fits the existing vocoder-style design.
- The shipped delay material (`slowGlass`, with `delayK = 0.002 s`
  per bench unit) is a regular dielectric; place one in front of a
  sensor to hear an echo whose tail length scales with the path
  through it. `MAX_DELAY = 2 s` matches the `DelayNode.maxDelayTime`
  ceiling and the tracer's `rayTimeAudio` clamp.
- **Chase gating** (Phase 2): `tracer.sensorBins` /
  `tracer.sensorDelay` are filled from the per-frame event log via
  `rebuildSensorsGated(uTphysical)` — events whose `rayTimeVisual`
  exceeds the real-time chase clock are skipped, so on a re-arm the
  synth-facing spectrum drains and refills as the wavefront sweeps
  back across the bench. The visual rate slider only stretches
  `uTvisual`, not `uTphysical`, so audio echo timing remains a function
  of `delayK` × geometry regardless of slider position. In a scene with
  no delay material every event carries `rayTimeVisual == 0` and
  `rayTimeAudio == 0`, so the gate is a no-op, the synth reads a fully
  populated spectrum, and `DelayNode.delayTime` stays at 0s — identical
  to pre-Phase-2 behaviour.
- **Selective re-arm**: the visual/audio chase only re-arms when the
  scene's *delay fingerprint* changes (see `delayFingerprint` in
  `ui.js`). Moving a crown-glass prism, tweaking a mirror's hue, or
  any edit at all in a no-delay scene leaves audio untouched — no
  drain, no echo tail glitch.

## Input/output symmetry

In any scale mode, input bucket `i` and output voice `i` cover the
same pitch *as long as both sides share mode + base + span*. In `log`
mode the same index `i` maps to roughly the same bucket on both sides.
Under identity optics (no elements placed), what you feed in comes
back out at the same pitch.

The **Independent scale** checkbox in the Sensors section breaks that
coupling: separate `synth-mode` / `synth-base` / `synth-span` controls
appear and drive the synth ladder independently. Lets you transpose
(input chromatic at C3, output chromatic at C5), compress (mic in
log, synth in pentatonic), or detune (different bases for slow beat
effects).

## Design notes

The audio path is structurally a **vocoder-style spectral
resynthesizer**, not a transparent A→B pipeline. The input spectrum is
bucketed into a handful of channels, mapped to spatial positions,
propagated through the optical simulation, then resynthesized as
fixed-pitch voices. In a clean (no-elements) scene the identity
mapping is only approximate; putting prisms, dichroics, or absorbers
in the scene is what makes the output differ meaningfully from the
input.
