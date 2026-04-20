# Architecture: Audio In / Out

## Audio in (`docs/mic.js`)

Toggle `Audio in` in the toolbar (or press `A`; Push Play button
CC 85 also toggles). `mic-source` picks the signal
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
- `touch/keys` (default) — combined touch + keyboard input, no
  AudioContext. Pointer events on the left edge of the bench (within
  60 bench pixels of the emitter ticks) set emitter levels directly
  by position. Keyboard claviature (same ZXCVBNM/SDGHJ layout)
  sets levels by scale degree. Both write to `_touchLevels`. Multi-
  touch supported. All emitters are force-enabled (disabled set
  cleared each frame). Context menu suppressed on the stage element.
  Touch events listen on `#stage` (not canvas) so the letterbox
  black bars also respond. `stopPropagation` on touch-zone pointers
  prevents UI element-toggle/drag interference.

- `file` — audio file decoded via `decodeAudioData`, looped via a
  `BufferSource`. Transport controls (play/pause/restart/time) exposed
  via `filePause()`, `fileResume()`, `fileRestart()`, `fileTime()`,
  `fileDuration()`. `disable()` clears `_fileBuffer`, `_filePlaying`,
  and `_fileOffset` so no stale transport state persists. Switching
  source in the dropdown resets the file transport buttons/time display.
  The file `<input>` resets `e.target.value` on change so the same file
  can be re-selected.

Mic, sine, harmonics, white, pink, keyboard, and file sources feed a
single `AnalyserNode` with `fftSize = 8192` and
`smoothingTimeConstant` set in `mic.js` `enable()`, so downstream code
doesn't know where the audio came from. Touch/keys and MIDI sources
bypass the AudioContext entirely — `directLevels()` returns emitter
levels directly.

`micBands(mic, n, mode, baseHz, stepSemi)` bins the FFT into `n`
buckets:

- **`log`** mode: log-spaced across 80–6000 Hz.
- **`voice`** mode: log-spaced across a focused 100–4000 Hz range
  optimized for vocal content. Treated identically to `log` in the
  code paths (same bucket-center spacing, same `directLevels` logic)
  but with the tighter frequency bounds. Span slider is hidden (same
  as log). `synth.setStep` skips rebuild for voice (like log).
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

All modes use `getFloatFrequencyData` (dB values). Normalization is
**split by source type**:

- **File source** (`mic.source === 'file'`): converts dB to linear
  amplitude via `dbToLin` (`10^(dB/20)`), then peak-normalizes using
  `_peakHold` (module-scope; rises instantly, decays at 0.95/frame —
  roughly 1 s to half at 60 fps). After normalization, `sqrt` shaping
  recovers spectral contrast from mastered broadband audio. A linear
  noise gate (`NOISE_GATE_LIN = 0.001`) blanks output when silent.
- **All other audio sources** (mic, sine, harmonics, noise, keyboard):
  absolute `dbNorm` mapping (dB → 0–1 via the analyser's fixed
  `minDecibels`/`maxDecibels` range). Floor 0.15, gamma 1.5 zero out
  quiet buckets. A noise gate (`NOISE_GATE = 0.10` on the normalized
  frame peak) blanks the entire output when nothing is playing. No
  peak-hold — the fixed dB range provides stable scaling so silence
  stays quiet.

Peak per bucket (not mean) gives sharper vocoder-like channel
separation in both paths. Result is written to
`scene.runtime.micLevels`. The renderer draws an amber bar extending
from each emitter tick proportional to its bucket.

**Bucket color** additionally assigns each source a narrow wavelength
band linearly mapped across the visible range via
`scene.runtime.wlPerSource`, so different notes show as different
colors.

## Audio out (`docs/synth.js`)

`Audio out` toggles the additive synth (or press `Q`). The entire
synth runs as a single `AudioWorkletProcessor` ("chromavox-synth"),
replacing the previous 313-node WebAudio graph (144 OscillatorNodes +
144 GainNodes + 24 voice-mix GainNodes + 1 master).

The worklet source is an inline template string loaded via Blob URL —
no separate `.js` file, no build step. `synth.enable()` is async
(awaits `audioWorklet.addModule`).

- **Voice pitch** uses the same base and step as the mic side, so
  input and output ladders line up. `synth.setBase(hz)` rebuilds
  voice frequencies for all modes (not just chromatic), so changing
  the Base dropdown takes effect immediately in any scale. Log mode
  uses 80–6000 Hz; voice mode uses 100–4000 Hz. Both use
  `(i+0.5)/n` bucket-center spacing matching `micBands`.
  `synth.setStep` skips rebuild for both log and voice (step is
  irrelevant when frequencies are log-spaced).
- **Carrier mode**: selectable via the Carrier dropdown in the Audio
  out options menu. Three modes:
  - `sine` (default): harmonic partials with 1/k rolloff for
    neutral sawtooth-like timbre from white light.
  - `noise`: unity-gain bandpass noise (Csound `resonz` topology).
    Single 2-pole resonator with zeros at DC/Nyquist:
    `bp = (y0 - y2) * (1-r²)/2`. Constant-Q (Q=25):
    `r = 1 - π·freq/(25·sr)`. Peak gain exactly 1.0 at all
    frequencies — no ampScale needed.
  - `acid`: 303-style acid carrier. PolyBLEP sawtooth → 3-pole
    TPT/ZDF diode ladder filter (18 dB/oct) with `tanh` feedback
    for resonance. Sensor energy drives filter cutoff (the squelch):
    `cutoff = freq × 2^(1 + voiceGain × envAmount × 5 octaves)`.
    Per-voice state: `sawPhase`, `lp1`, `lp2`, `lp3`. Resonance
    and Env Amount sliders posted via MessagePort. Post-filter drive
    via `tanh(s3 × 2.5)`.
- **Partials**: adjustable 1–8 via the Partials slider (default 6).
  Each voice synthesises that many harmonic overtones with
  `Math.sin` directly (no wavetable). Harmonic gains come from
  grouping the sensor's wavelength bins with 1/k rolloff; per-voice
  timbre depends on which colors hit that sensor. Partials slider
  visible only in sine mode; hidden in noise and acid modes.
  `synth.setPartials(n)` and `synth.setCarrier(mode)` post to the
  worklet via `MessagePort`.
- **Data flow**: main thread posts `sensorBins` via `MessagePort` each
  frame (~6 KB/frame: sensors × bins × 4 bytes). The worklet reads
  the latest snapshot in `process()`. Rebuild sends a new frequency
  array via `MessagePort` — no node teardown/recreation.
- **Gain smoothing**: per-sample exponential smoothing (~60 ms time
  constant) inside the worklet replaces the old `setTargetAtTime`
  calls, preventing zipper noise from single-frame spikes.
- **Fixed-range normalization**: the worklet receives `fullScale`
  (`BASE_INTENSITY * sqrt(raysPer)`) via the rebuild message. Each
  partial's sensor bin sum is divided by `fullScale / gainK` to
  recover the 0–1 micGain scale (`gainK` = `K` for sine, `1` for
  noise and acid since they use a single band). A floor of 0.15
  and gamma of 1.5 shape the gain, then `1 / sqrt(sc * gainK)`
  scales for multi-voice headroom. Sine partials get 1/k rolloff.
  A `tanh` soft limiter at ±0.8 prevents hard clipping when many
  voices overlap. No peak-hold — quiet voices stay quiet relative
  to loud ones, matching the mic spectrum's absolute scaling.
- **Voice stealing**: voices whose gains are all < 1e-5 are skipped
  entirely in the render loop.
- Master gain slider posts a gain value via `MessagePort`.
- Output device picker uses `AudioContext.setSinkId()` where
  supported. Older browsers silently fall back to the system default.
- No `SharedArrayBuffer`, no COOP/COEP headers needed.
- **Optical delay** (Phase 3): each delay element holds a
  `ParticlePool` in the tracer; photons that enter a slow-glass are
  captured and propagated one advance-step per frame at
  `1 / delayK` bench units per second. When they exit, they refract
  out and contribute to the sensor on the frame they arrive. The
  synth doesn't need a `DelayNode` — audio delay is the *physical*
  result of photons arriving late. Voices go
  `voiceMix → master` directly.
- The shipped delay material (`slowGlass`, `delayK = 0.002 s` per
  bench unit) is a regular dielectric; place one in front of a
  sensor to hear the note arrive late, with its attack stretched
  over the transit time.  Hold a keyboard note and release it — the
  synth keeps playing until the last held photon drains out of the
  glass, because the tracer is still depositing on the sensor every
  frame during that drain.
- **Sim rate** slider (Audio in dropdown): log-scaled multiplier
  on the particle advance `dt`. `4×` makes slow-glass drain 4× faster;
  `0.25×` makes it 4× more viscous. Default 1× (real time).

## Spectrum readout smoothing

`renderer.updateReadout(scene, tracer)` applies three smoothing stages
before writing to the right-panel bar display:

- **(A) Gaussian blur** — a [0.25, 0.5, 0.25] kernel across bins.
- **(C) Temporal IIR** — `_displayBins` lerps toward the new value at
  factor 0.3 each frame.
- **(D) Peak normalization** — `_peakMax` decays at 0.95 per frame,
  giving a slow-decaying peak hold that prevents jumpy rescaling.

`_displayBins`, `_peakMax`, and `_blurBuf` are Renderer instance fields
(not module-scope variables in `main.js`). `renderer.resetReadout()`
zeros them; called by `resetDisplay` (via the `onSceneReset` callback)
on clear, file-load, or preset-load so stale smoothing state doesn't
bleed across scenes.

## Synth spectrum debug window

Toggled via the **Synth spectrum** checkbox in the left panel (below
Mic spectrum). Floating draggable window identical in structure to the
mic spectrum window. Shows the actual FFT of the synth's audio output
via an `AnalyserNode` (`fftSize=8192`, `smoothing=0.6`) tapped between
the worklet node and master gain in the audio graph. Log-frequency
axis 80–6000 Hz with `getFloatFrequencyData`. Reflects the real output
including harmonic partials, carrier mode (sine peaks vs noise bands),
and the `tanh` soft limiter. Changing partials or carrier mode is
immediately visible in the spectrum.

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
