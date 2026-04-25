# Architecture: Audio In / Out

## Audio in (`docs/js/input.js`)

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
  sets levels by scale degree. Both write to `_touchTargets` (not
  `_touchLevels` directly); actual levels ramp toward targets each
  frame via `smoothTouchLevels()` — attack 0.2/frame (~50 ms),
  release 0.15/frame (~66 ms). This prevents clicks from instant
  0→1 steps into the vocoder or other carriers. `mic.onTouchChange`
  callback wakes the frame loop on keyboard note on/off so the ramp
  runs immediately. Multi-touch supported. All emitters are force-
  enabled (disabled set cleared each frame). Context menu suppressed
  on the stage element. Touch events listen on `#stage` (not canvas)
  so the letterbox black bars also respond. `stopPropagation` on
  touch-zone pointers prevents UI element-toggle/drag interference.

- `file` — audio file decoded via `decodeAudioData`, looped via a
  `BufferSource`. Transport controls (play/pause/restart/time) exposed
  via `filePause()`, `fileResume()`, `fileRestart()`, `fileTime()`,
  `fileDuration()`. `disable()` clears `_fileBuffer`, `_filePlaying`,
  and `_fileOffset` so no stale transport state persists, but
  `_decodedFile` persists across `disable()` cycles so file audio can
  resume without re-picking. Switching source in the dropdown resets
  the file transport buttons/time display. The file `<input>` resets
  `e.target.value` on change so the same file can be re-selected.

Mic, sine, harmonics, white, pink, keyboard, and file sources feed a
single `AnalyserNode` with `fftSize = 8192` and
`smoothingTimeConstant` set in `input.js` `enable()`, so downstream code
doesn't know where the audio came from. Touch/keys and MIDI sources
bypass the AudioContext entirely — `directLevels()` returns emitter
levels directly.

**Touch/keys always active**: the touch zone and keyboard claviature
work alongside any source, not only when `touch/keys` is selected.
`_installKeyboard()` is extracted and called for all sources in the
constructor. Touch/keys levels overlay on any other source's levels
via `max()` — e.g. during song playback, touching the bench edge or
pressing claviature keys adds to the file/mic levels rather than
replacing them.

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
  roughly 1 s to half at 60 fps). Linear output (no sqrt, no gamma).
  A linear noise gate (`NOISE_GATE_LIN = 0.001`) blanks output when
  silent.
- **All other audio sources** (mic, sine, harmonics, noise, keyboard):
  absolute `dbNorm` mapping (dB → 0–1 via the analyser's fixed
  `minDecibels`/`maxDecibels` range). Scale-mode floor is 0.45 (steep
  cutoff suppresses ambient noise); log-mode floor is 0.20. A noise
  gate (`NOISE_GATE = 0.10` on the normalized frame peak) blanks the
  entire output when nothing is playing. No peak-hold — the fixed dB
  range provides stable scaling so silence stays quiet.

Peak per bucket (not mean) gives sharper vocoder-like channel
separation in both paths. `_peakHold` is reset to 0 in `enable()` so
stale values don't persist across source switches. Result is written
to `scene.runtime.micLevels`. The renderer draws an amber bar extending
from each emitter tick proportional to its bucket.

**Bucket color** additionally assigns each source a narrow wavelength
band linearly mapped across the visible range via
`scene.runtime.wlPerSource`, so different notes show as different
colors.

## Audio out (`docs/js/synth.js`)

`Audio out` toggles the additive synth (or press `Q`). The entire
synth runs as a single `AudioWorkletProcessor` ("chromavox-synth"),
replacing the previous 313-node WebAudio graph (144 OscillatorNodes +
144 GainNodes + 24 voice-mix GainNodes + 1 master).

The worklet lives in a standalone file (`docs/js/synth-worklet.js`) with
full IDE support. `synth.js` fetches the file, patches the
`__PARAM_DEFAULTS__` placeholder with a JSON blob of carrier parameter
defaults (from `carriers.js`), then creates a Blob URL and calls
`audioWorklet.addModule`. The fetched source is cached in `_WORKLET_SRC`
so subsequent `enable()` calls skip the fetch. `synth.enable()` is
async; a try/catch around the fetch + addModule cleans up the
AudioContext on failure (prevents leaked contexts). Tests load the
worklet source via `readFileSync` + the same placeholder patching.

`synth.js` itself is ~190 lines — just the main-thread API (enable,
disable, rebuild, setCarrier, setBase, etc.) and MessagePort plumbing.

The AudioContext is constructed with `{ latencyHint: 'playback' }` —
~50 ms extra output buffer is acceptable for a synth driven by scene
geometry, and the larger buffer is more forgiving against block-rate
hiccups. The graph is `workletNode → master → destination`; the
`AnalyserNode` for the synth-spectrum debug window is branched off
`master` as a passive tap (not in the live signal path).

- **Voice pitch** uses the same base and step as the mic side, so
  input and output ladders line up. `synth.setBase(hz)` rebuilds
  voice frequencies for all modes (not just chromatic), so changing
  the Base dropdown takes effect immediately in any scale. Log mode
  uses 80–6000 Hz; voice mode uses 100–4000 Hz. Both use
  `(i+0.5)/n` bucket-center spacing matching `micBands`.
  `synth.setStep` skips rebuild for both log and voice (step is
  irrelevant when frequencies are log-spaced).
- **Carrier mode**: selectable via the Carrier dropdown in the Audio
  out options menu. Carrier parameters are defined in `docs/js/carriers.js`
  (single source of truth for UI, persistence, automation, and worklet
  defaults). Each carrier is a standalone function in the worklet
  (`_carrierSine`, `_carrierAcid`, `_carrierFM`, `_carrierSupersaw`,
  `_carrierNoise`, `_carrierPulse`, `_carrierVocoder`,
  `_carrierKarplus`), dispatched via a constant map
  `_CARRIERS = { sine: _carrierSine, ... }`. The voice loop calls
  `_CARRIERS[this.carrier](v, ctx)` — no if/else chain. Nine modes:
  - `sine` (default): harmonic partials with 1/k rolloff for
    neutral sawtooth-like timbre from white light. Bin-to-partial
    mapping is **inverted**: blue light (low wavelength bins) drives
    high partials (brighter timbre), red (high bins) drives the
    fundamental (purer tone).
  - `noise`: unity-gain bandpass noise (Csound `resonz` topology).
    Single 2-pole resonator with zeros at DC/Nyquist:
    `bp = (y0 - y2) * (1-r²)/2`. Variable Q via the **Q slider**
    (range 1-50, default 14): `r = 1 - π·freq/(Q·sr)`. Peak gain
    exactly 1.0 at all frequencies — no ampScale needed.
  - `acid`: 303-style acid carrier. PolyBLEP sawtooth → 3-pole
    TPT/ZDF diode ladder filter (18 dB/oct) with `tanh` feedback
    for resonance. Sensor energy drives filter cutoff (the squelch):
    `cutoff = freq × 2^(1 + voiceGain × envAmount × 5 octaves)`.
    Per-voice state: `sawPhase`, `lp1`, `lp2`, `lp3`. Resonance,
    Env Amount, Cutoff, Decay, and Drive sliders posted via
    MessagePort. Post-filter drive via `tanh(s3 × 2.5)`.
  - `fm`: FM synthesis carrier. Ratio slider (1-8) sets the
    modulator:carrier frequency ratio. Depth slider (0-1) sets
    modulation index.
  - `supersaw`: 7 detuned sawtooth oscillators. Detune slider (0-1)
    controls spread.
  - `pulse`: PolyBLEP variable-width pulse wave. **Width** slider
    (0.05-0.95, default 0.5) sets the base duty cycle. Two PolyBLEP
    corrections (at 0 and at the duty cycle crossing) give clean
    anti-aliased edges.
  - `vocoder`: classic vocoder topology — shared broadband excitation
    → 4th-order bandpass (two cascaded biquads in DF-II Transposed
    form, 24 dB/oct) → envelope-modulated output per voice. Shared
    excitation computed once per block at fixed 100 Hz (PolyBLEP saw);
    all voices filter the same signal. Auto-Q from voice spacing:
    `Q = 1/(ratio - 1)` where `ratio = (6000/80)^(1/N)` (~10.4 for
    48 voices). Gain normalization `1/(Q*0.5)` compensates for filter
    peak gain. Per-voice centroid modulates Q over ±1 octave
    (`qMod = 2^((centroid-0.5)*2)`) — bright input tightens the
    formant, dull input widens it. Fast per-sample envelope (default
    5 ms attack / 20 ms release) applied PRE-filter to prevent biquad
    state buildup clicks. Biquad states (2 per biquad) and `vocEnv`
    cleared in the `!anyActive` branch to prevent reactivation clicks.
    Three sliders: **Excite** (noise 0 / mix 0.5 / pulse 1),
    **Attack** (1–50 ms), **Release** (5–200 ms).
  - `karplus`: Karplus-Strong physical string model. Per-voice delay
    line (length = `ceil(sampleRate / freq)`). **Damping** slider
    (0-1, default 0.4) controls feedback lowpass coefficient (higher
    = faster decay). **Excite** slider (0-1, default 0.5) blends
    between continuous excitation (bowed-string-like, low values) and
    transient-only re-excitation (plucked, high values). Transient
    mode triggers on rising gain edges (threshold `>= 0.05`).
    Variable lowpass filter in the feedback loop, with cutoff
    controlled by the Damping parameter.
  - `piano`: modal synthesis with gain-edge attacks. Per-voice state
    is 12 slightly-inharmonic partials with running peak amplitudes.
    Strike model: rising edges in per-sample `voiceGain` inject
    energy proportional to `_PIANO_MIX[n] * gainRise * velocity^exp`
    into each partial's peak; between strikes each partial decays
    exponentially at its own rate (low partials ring long, high die
    fast). Frequency-dependent decay scaling via
    `freqDecayFactor = (261/f)^0.7` so bass sustains longer than
    treble. Inharmonicity coefficient `B = stretch · 0.0005 ·
    (261/f)²` applied as `f_n = n·f·√(1 + B·n²)` — bass gets more
    stretch, matching real piano tuning. Nyquist-safe: partials above
    `0.95·nyq` have `dts[n]=0` and don't output. Voice stays alive
    after `voiceGain` drops as long as any `v.pianoPeak[n] > 1e-5`,
    so the modal tail rings naturally. Three sliders: **Decay**
    (0.2–3× ring time), **Brightness** (velocity→partial slope),
    **Stretch** (0 = organ, 1 = concert grand).
    Per-voice state (`v.pianoPhases/pianoPeak/pianoDts/
    pianoDecayPerSample`, each `Float32Array(12)`) is pre-allocated
    in `_rebuildPartials` for hidden-class stability; `pianoDts` is
    rebuilt on freq or stretch change (`pianoDtsFreq` +
    `pianoDtsStretch` guards).
- **Spectral centroid**: for all non-sine carriers, each voice
  computes a spectral centroid from its wavelength bins. The centroid
  is **inverted**: blue (short wavelength, low bins) → 1.0 (bright),
  red (long wavelength, high bins) → 0.0 (dark). Falls back to
  position-based centroid (from sensor index) when there's no
  wavelength data (passthrough). Block-rate smoothing:
  `centroidSmooth = 1 - (1 - smooth)^blockLength` (applied once per
  render block, not per sample, for correct coefficient scaling).
  Per-carrier centroid mapping:
  - `acid` → cutoff shift (±2 octaves from base cutoff)
  - `noise` → bandpass center frequency shift (±1 octave)
  - `fm` → ratio modulation (0.5x-1.5x of base ratio)
  - `supersaw` → detune modulation (0x-2x of base detune)
  - `pulse` → duty cycle shift (blue narrows, red widens)
  - `karplus` → excitation filter cutoff (blue = bright/shimmery,
    red = dark/woody) plus feedback damping amount
  - `vocoder` → per-voice Q modulation (`qMod = 2^((centroid-0.5)*2)`,
    ±1 octave on Q). Bright input tightens the formant filter; dull
    input widens it — a focused vowel vs. a breathy one. The base `Q`
    is a block constant on `ctx.vocQ`; carrier applies `qMod` per voice
    and recomputes `gainNorm = 1 / max(1, Q * 0.5)` per voice.
  - `piano` → upper-partial brightness (`centroidBoost = 1 +
    (centroid-0.5)·1.5`, applied only to new strike energy in
    partials 4+). Blue-dominant strikes emphasise the upper modal
    partials; red-dominant strikes produce a mellower tone.
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
- **Stereo output**: `AudioWorkletNode` uses `outputChannelCount: [2]`.
  Constant-power pan per voice: sensor 0 pans left, sensor N-1 pans
  right. Pan law is `cos/sin(pan * PI/2)`. Soft limiter applied
  independently to both channels.
- **Sine wavetable (`fsin` / `fsinFast`)**: 2049-entry LUT
  (`_SIN_N = 2048` + one boundary sample for wrap-free interpolation),
  linear interpolation. Two variants:
  - `fsin(x)` accepts any real `x` — does float + int modulo to wrap
    into table range. Used by carriers whose phase argument can
    overshoot (FM's combined `cPhase + fsin(mPhase) * …`).
  - `fsinFast(x)` assumes `x` is already in `[0, _SIN_N)` — no
    modulo, two table loads. Used by sine and piano, which both
    store their phases in **table-index space** and wrap themselves
    (`phase -= _SIN_N` when `>= _SIN_N`). Phase increment is
    `freq * invSr * _SIN_N` (replaces the older `twoPi * freq * invSr`
    radian-space form). On mobile JITs this gives a noticeably
    smaller inner loop that reliably stays inlined.
- **Voice phase state storage**: `v.phases`, `v.gains`, `v.targetGains`
  are `Float32Array`s allocated to the correct partial count in
  `_rebuildPartials` (sine's partials that fit under Nyquist). Stable
  element-kind across JIT runs; halves memory per partial vs. plain
  `Array<number>`. Matches the typed-array pattern already used by
  `ssPhases`, `kpBuf`, `voc1/2`, `pianoPhases/Peak/Dts`, etc.
- **PRNG policy**: `_carrierNoise` and `_carrierKarplus` per-sample
  per-voice calls use `Math.random()` — a shared Mulberry32 stream
  across voices introduced audible inter-voice correlation. A
  module-level Mulberry32 (`_rng`) is used only where that problem is
  structurally impossible: the vocoder's shared broadband excitation
  buffer (single PRNG, not per-voice) and the karplus note-on burst
  (one-shot per note transient, not in the sample loop).
- **Global constant maps** (module scope in `synth-worklet.js`,
  outside `process()`):
  - `_SINGLE_BAND` — which carriers use `gainK=1` (single-band
    normalization instead of multi-partial `K`).
  - `_SMOOTH_SEC` — per-carrier gain smoothing time constants
    (karplus 5 ms, pulse 30 ms, acid 40 ms, noise/FM/supersaw 60 ms,
    sine 80 ms).
  - `_CARRIERS` — function dispatch table mapping carrier name to
    function.
  - Replaced 7 `isXxx` boolean flags with one `isVocoder` (for shared
    excitation buffer).
- **Shared carrier context (`ctx`)**: a flat object with `bufL, bufR,
  len, smooth, centroidSmooth, twoPi, invSr, sc, P, vocExc, panL,
  panR` passed to every carrier function. Cached on `this._ctx` —
  properties updated in place each `process()` call, zero allocation
  after the first call. No destructuring; all carriers use `ctx.`
  property access directly (V8 hidden class optimization).
- **Hot-path allocation removal**: `ctx` object cached on `this._ctx`;
  vocoder excitation buffer cached on `this._vocExcBuf`; supersaw `dts`
  array cached on `v._ssDts` per voice; supersaw `dr` array literal
  replaced with individual variables. Zero allocations in `process()`
  after first call.
- **Gain smoothing**: per-carrier time constants (from `_SMOOTH_SEC`)
  inside the worklet replace the old uniform ~60 ms smoothing.
  Prevents zipper noise from single-frame spikes.
- **Acid filter zipper reduction**: `tan(g)` recomputed every 32
  samples instead of once per block, smoothing cutoff modulation.
  `Math.exp(voiceGain * envScale * ln2)` for the envelope-driven
  cutoff target is evaluated at the same 32-sample rate (the per-
  sample one-pole `envSmooth` lerp still fills the stairstep). Saves
  ~124 `Math.exp` calls per block per acid voice.
- **Vocoder biquad form**: DF-II Transposed (`y = b0*x + z1; z1 = z2 -
  a1*y; z2 = b2*x - a2*y`). Two state floats per biquad instead of
  four; no state shuffling (`s[1]=s[0]; s[0]=exc; …`). `b1 = 0` for
  BPF, simplified. `v.voc1` / `v.voc2` are `Float32Array(2)`.
- **Vocoder per-block constants**: `ratio`, `vocQ`, `vocAtk`, `vocRel`
  are computed once per `process()` on `ctx.vocQ`/`vocAtk`/`vocRel`
  instead of per voice. Avoids N_voices × (`Math.pow` + 2 × `Math.exp`)
  per block.
- **Sine phase-increment hoist**: the per-partial phase increment
  `twoPi * freq * (k+1) * invSr` is computed once per block into a
  scratch array `v._sineDts` (lazy-allocated) and reused across all
  samples. Saves 3 FLOP × K × 128 per voice.
- **Denormal guards**: acid (`s1/s2/s3`), vocoder (`z1a/z2a/z1b/z2b`),
  and noise (`y1/y2`) filter states are clamped to zero if their
  absolute value drops below 1e-20 at block boundaries. Prevents the
  10–100× CPU stall that subnormal arithmetic causes on x86 without
  FTZ/DAZ.
- **Fixed-range normalization**: the worklet receives `fullScale`
  (`BASE_INTENSITY * sqrt(raysPer)`) via the rebuild message. Each
  partial's sensor bin sum is divided by `fullScale / gainK` to
  recover the 0–1 micGain scale (`gainK` = `K` for sine, `1` for
  noise and other single-band carriers). A floor of 0.02 (linear,
  no gamma) and `1 / sqrt(sc * gainK)` scales for multi-voice
  headroom. Sine partials get 1/k rolloff.
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

## Freeverb master reverb

Jezar Wakefield's Schroeder-style reverb, applied inside the worklet's
`process()` **after** all voices have summed into `bufL/bufR` and
**before** the output `ftanh` soft-limiter. Living pre-limiter means
runaway comb-filter resonance gets smoothly caught by tanh rather than
clipped after the fact.

Topology:
- 8 parallel comb filters per channel, each with a 1-pole LP in the
  feedback path (the "damping" filter).
- 4 serial allpass filters per channel, fixed feedback 0.5.
- 23-sample stereo-spread offset added to every right-channel delay
  length for decorrelation.
- Input to reverb: `(bufL + bufR) · 0.015` (mono-sum, 36 dB attenuation
  so feedback paths can't runaway from full-scale input).
- Output mix: `bufL[i] = dry·inL + wet·outL` (same for R).

Tuned delay lengths (samples, Jezar's primes at 44.1 kHz, used as-is
at 48 kHz — tonal character shifts slightly but that's standard):
- Combs: `1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617`
- Allpass: `556, 441, 341, 225`

Params (on worklet `this.P`, default 0):
- `reverbMix` (0–1): wet amount.
- `reverbSize` (0–1) → comb feedback `0.28 + size·0.7` (= 0.28…0.98).
- `reverbDamping` (0–1) → LP coefficient in feedback, `damp·0.4`
  (= 0..0.4). Higher damping kills high-frequency modes faster.

Bypass: when both `reverbMix` target and `_rvWetSmooth` state are
below `1e-4` the function returns immediately — no state advance, no
cost. Audio-rate wet-mix smoothing (`~30 ms` time constant) prevents
clicks when toggling the slider.

Denormal guard: the 16 comb LP states are clamped to 0 at the end of
each block if their absolute value drops below `1e-20`. Without it,
long-silent reverb states drift into subnormal arithmetic (10–100×
slowdown on x86).

State is allocated once in `_initReverb()` from the constructor:
stereo-paired `Float32Array` comb buffers and allpass buffers, plus
`Uint32Array` write indices. No hot-path allocation.

UI: single **Reverb** slider below **Volume** in the Audio-out options
menu (`#synth-reverb` in `play.html`). Persisted via
`UI_CONTROL_IDS → localStorage`. Automatable in songs via
`{ "param": "reverbMix", "points": [...] }` — routes through the same
`synth.setParam` pipeline the carrier params use.

## Voice activity gate and coast counter

`process()` gates each voice before calling its carrier:

1. **Sensor-driven**: active if any of `v.gains[k] > 1e-5` or
   `v.targetGains[k] > 1e-5`. True for any carrier whose voice is
   receiving sensor light.
2. **Piano ringing**: additionally active if any `v.pianoPeak[n] >
   1e-5`. Partials decay exponentially for several seconds after
   sensor light drops; voice must keep running so the tail renders.
3. **Coast**: when both (1) and (2) fail, decrements `v.coast` and
   stays active for up to 3 more blocks (~8 ms at 48 kHz). Per-sample
   gain smoothing continues to pull `gains[k]` through zero during
   those blocks, so the output contribution decays to zero
   *continuously* instead of cliff-edging at the block boundary
   where the gate would otherwise flip. The cliff used to be
   rendered as a sample-aligned impulse by Firefox Mobile's output
   resampler, producing audible clicks.

**Carrier-switch state alignment**: when the worklet receives a
`'carrier'` message whose new value is `'piano'`, it sets
`v.pianoPrevGain = v.gains[0]` for every voice. Otherwise the first
piano block would see
`gainRise = voiceGain - stalePianoPrevGain ≫ 0` and inject a phantom
strike based on whatever the previous carrier's gain state was.

## Diagnostic stats

The `stats` postMessage from the worklet carries extra diagnostic
fields beyond the basic `voices` / `activeVoices` / `blockSize` /
`droppedBuffers`. All are collected only when the stats window is
open (worklet checks `this._statsEnabled`) so per-block overhead is
zero during normal playback.

- `maxBlockMs` — wall-clock duration of `process()` this window.
  Budget is `128 / sampleRate * 1000 ≈ 2.67 ms` at 48 kHz. Values
  above ~2 ms mean xruns are imminent even if not yet happening.
- `driftMs` — cumulative wall-clock vs audio-clock skew since stats
  were enabled. Positive = worklet falling behind real time.
- `maxSampleStep` — largest `|bufL[i] - bufL[i-1]|` post-limiter
  within the block. Catches signal-level discontinuities.
- `maxBoundaryStep` — `|bufL[0] - bufL_prev[len-1]|`. Isolates
  block-boundary jumps (voice-skip / voice-wake transitions) from
  mid-block discontinuities.
- `maxD2` — largest `|2·bufL[i] - bufL[i-1] - bufL[i+1]|`. Catches
  single-sample impulses that first-order derivatives miss on
  high-frequency content.
- `msgsPerBlockMax` — max count of `port.onmessage` invocations
  between consecutive `process()` calls in the window. Excess
  indicates main → worklet message pressure.

On platforms where `performance.now()` is unavailable in the worklet
scope (historically Firefox Android), `maxBlockMs` and `driftMs` are
reported as `null` (displayed as `-`) while the signal-continuity
fields still populate — those don't need high-resolution timers.

**`_statsEnabled` gating**: main.js calls `synth.setStatsEnabled(true)`
when the stats window opens and `false` when it closes. The worklet
flips an internal flag and additionally primes `_processCount = 187`
on enable so the first stats message arrives within one block
instead of waiting the usual ~500 ms interval. When disabled, the
worklet skips both the signal scan and the postMessage — zero worklet
→ main-thread traffic during normal playback.

main.js also tracks **RAF p99** (99th-percentile frame-to-frame
interval over the last ~240 RAF callbacks) and shows it in the stats
window. Lets you correlate audio glitches with main-thread stalls.

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
