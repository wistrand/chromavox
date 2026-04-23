# Chromavox

Optical synthesizer. Audio input drives a row of light emitters on the left
wall; an additive synth plays back what arrives at sensors on the right wall.
Placeable prisms, lenses, mirrors, colored glass, and dichroic mirrors between
them reshape the pitch mapping, timbre, and routing of the sound. Underneath
is a real 2D optics simulation — Snell refraction, Sellmeier (or Cauchy)
wavelength-dependent index, Beer-Lambert absorption, dichroic reflectance.
Plain HTML + ES modules + WebGL2, no dependencies.

## Run

```
npm start                    # node serve.js, port 8005
node serve.js 9000           # override port
node serve.js --push-display # also spawn Push display sidecar
```

ES modules require HTTP (not `file://`). Server ROOT is `docs/`, which is
also the GitHub Pages folder.

## Tests

`npm test` runs `test/run.js` (Node, no browser, no dependencies).
Do not run tests unless explicitly asked or when a change is likely to
break core math/physics (spectrum, scene geometry, tracer capture/exit).

## Architecture docs

Detailed notes are split into topic files under `agent_docs/`:

- [Overview & module layout](agent_docs/architecture-overview.md)
- [Ray tracer](agent_docs/architecture-raytracer.md)
- [Materials](agent_docs/architecture-materials.md)
- [Elements](agent_docs/architecture-elements.md)
- [Audio in / out](agent_docs/architecture-audio.md)
- [UI & state](agent_docs/architecture-ui.md)
- [Delay materials](agent_docs/architecture-delay.md)
- [MIDI input](agent_docs/architecture-midi.md)
- [Ableton Push](agent_docs/architecture-push.md)
- [Akai controllers](agent_docs/architecture-akai-controllers.md)
- [GPU tracer](agent_docs/architecture-gpu-tracer.md)
- [Song format design](agent_docs/design-song-format.md)
- [Known gotchas](agent_docs/architecture-gotchas.md)

Note: `agent_docs/plan-element-schema.md` was removed (implemented).


## Conventions

- **No build step.** No bundlers, transpilers, or runtime deps.
  Browser loads `main.js` via `<script type="module">`.
- **No shader loader.** All GLSL lives as template strings in javascript.
- **ES modules only.** `package.json` sets `"type": "module"`.
- **2-space indentation** in `.js`, `.html`, `<style>`.
- **No AI-isms in user-facing text.** Keep prose direct and
  concrete.
- **Mind GC pressure and wasted work on hot paths.** 
  Prefer pooled scratch objects
  over per-call allocations, pass out-parameters instead of
  returning fresh objects, skip work when there's nothing to do
  (invisible hint, unchanged state, culled region), and guard
  the biggest loops with tighter iteration bounds


## Key invariants to remember

- Coordinates are bench pixels; y is **down**. Polygon winding and
  outward-normal sign in `worldEdges` depend on it.
- `worldEdges()` returns mixed edge types: segments
  (`{type:'seg', p1, p2, nx, ny, elementId}`) and arcs
  (`{type:'arc', cx, cy, R, a0, a1, convex, elementId}`). Arc-bearing
  elements (lens-convex, lens-concave, circle, mirror-concave,
  mirror-convex) emit analytic arcs; others emit segments.
  `localPolygon()` still returns dense vertex lists for rendering,
  hit-testing, and particle exit — only the physics edge list changed.
  Arc normal is `(hit - center) / R`, flipped for concave surfaces.
- Tracer never branches rays (no Fresnel split). TIR reflects; dichroic
  mirror absorbs the non-reflected fraction. Keeps the vertex buffer
  size predictable.
- Nested / overlapping dielectrics use an inside-element *stack*
  (`this._stack`) so `n1` / `n2` and Beer-Lambert α reflect the actual
  current medium, not just "vacuum or this element".
- Ray hot loop avoids allocations: walls and inside-stack are reused
  Tracer fields; element infos iterate as an array, not a Map iterator.
- Equilateral prism requires `n < 2` for any transmission. `diamond`
  always TIRs; `hyper` is tuned to satisfy the bound.
- Undo/redo batches via `beginEdit` / `endEdit`; drags and slider scrubs
  collapse into one history entry.
- Scene JSON is `version: 1`. IDs are regenerated on deserialize;
  `bumpIdCeiling` keeps the running counter ahead of any restored max.
  `serializeScene` also emits `title` (auto-generated compact label from
  element counts + carrier name via `autoTitle(scene)`), `date` (ISO
  timestamp), and optional `synth: { carrier, params }`. The Save button
  uses the title to derive the download filename
  (`chromavox-<slug>.json` via `filenameFromTitle` in `ui.js`) and
  `main.js` sets `document.title = 'Chromavox - ' + autoTitle(scene)`
  on init and on every `markDirty`.
- MusicXML import: `docs/js/musicxml.js` converts MusicXML → song JSON
  at runtime. UI: `⇪` button next to the song selector (file picker)
  plus drag-and-drop onto `#stage` (dashed outline feedback via
  `.drop-target`). Dropped files auto-play; picked files stay manual.
  Handles UTF-16 BOM (Finale exports are UTF-16 BE), content-sniffs
  `<` vs `{` so the same handler accepts native Chromavox song JSON
  too. Multi-part merging (voice + piano + everything else is unioned
  into one note stream). If score metadata mentions "piano" the
  imported song defaults to `carrier: "piano"`, otherwise sine.
  Decodes common ABC/TeX backslash escapes (`\"a` → ä, `\aa` → å) in
  titles; takes `<movement-title>` first line only.
- Freeverb master reverb lives in the worklet (`_applyReverb` on
  `ChromavoxSynth`), inserted between voice summation and the `ftanh`
  soft-limiter. Jezar's tuning: 8 parallel comb filters + 4 serial
  allpass per channel, 23-sample right-channel stereo-spread. Three
  params in `this.P`: `reverbMix` (0–1, wet), `reverbSize` (comb
  feedback 0.28..0.98), `reverbDamping` (LP in feedback 0..0.4).
  Fully bypasses when both mix target and smoothed wet are < 1e-4.
  30 ms wet-mix smoothing avoids clicks on toggle. Denormal guard on
  comb LP states each block. UI is a Reverb slider under Audio out.
  Automatable in songs via `param: "reverbMix"` (routes through the
  same `synth.setParam` pipeline).
- Song player mutates `scene.elements` in place (not rebuild-per-frame)
  so per-element accumulated state — notably `el.rot` driven by the
  main-loop spin integrator — survives across frames. Rotation lerp
  is skipped for elements with `el.spin`; the spin integrator owns
  `rot` in that case.
- `SongPlayer.load()` fires `onStateChange('stopped')` at the end so
  switching songs while playing resets the play button icon, seek
  bar, and time readout. Previously the state flipped silently and
  the UI stayed stuck on the previous song's pause icon.
- Song-file drop and welcome overlay: `#stage` accepts drag-dropped
  song files (JSON or MusicXML, UTF-8 or UTF-16) and auto-plays on
  drop. The welcome overlay itself is clickable (same effect as
  pressing ▶) so tapping "Press ▶ to play" actually plays. Both
  gestures count as user-interaction so the AudioContext starts.
- Song bend-lerp automation: `param: "bend"` in `song.automation`
  lerps `mic._globalBend` over time. User touching the wl-bend slider
  sets `songPlayer.bendPaused = true` (same semantics as touching an
  element sets `keyframesPaused`) — only the bend lane is suppressed,
  other automation keeps running. MIDI channel-0 pitch bend triggers
  the same pause via `mic.onGlobalBend`.
- Repeat button (`⟳`) in the transport bar toggles `songPlayer.song.loop`
  on the currently-loaded song. `loadSongJson` calls `syncLoopBtn()`
  to reflect the song's `loop` field on the button. MusicXML imports
  default `loop: true` (drop a score → keeps playing until stopped).
  Catalogued songs use whatever `loop` is in their JSON.
- Sine and piano carriers store phases in **table-index space**
  (`[0, _SIN_N)` where `_SIN_N = 2048`), not radians. Inner loops call
  `fsinFast(x)` — no modulos, two table loads — instead of `fsin(x)`.
  Phase increment is `freq * invSr * _SIN_N` (was `twoPi * freq * invSr`).
  Wrap threshold is `_SIN_N` (was `twoPi`). Required for `fsinFast`'s
  contract: `x` must be in `[0, _SIN_N)`. FM and other carriers still
  use `fsin` (their combined modulation argument can overshoot).
- Coast counter on every voice: when the active-voice gate wants to
  skip a voice (all gains < 1e-5, piano peaks < 1e-5), it instead
  decrements `v.coast` and keeps running the carrier for ~3 more
  blocks. Per-sample gain smoothing continues to pull gains through
  zero during those blocks, eliminating the sample-aligned cliff at
  the skipped→active block boundary that Firefox Mobile's output
  resampler used to render as clicks.
- Piano strike-edge reference is aligned on carrier switch: when the
  incoming carrier is `'piano'`, `v.pianoPrevGain = v.gains[0]` for
  every voice so the next block's `gainRise ≈ 0` (no phantom attack
  from whatever the previous carrier's gain state was).
- Voice gains/targetGains/phases are `Float32Array`s (not plain
  arrays). Consistent with the rest of per-voice state, stable
  element-kind for mobile JITs, halves memory per partial.
- Worklet stats (`this.port.postMessage({type: 'stats', …})`) are
  gated on `_statsEnabled`. Default off; main.js flips it on when
  the stats window is shown and off when hidden. Zero worklet →
  main-thread traffic during normal playback. On enable, the worklet
  primes `_processCount = 187` so stats arrive within one block
  instead of waiting up to ~500 ms.
- Stats window extra diagnostics (when visible): `CPU/block`, `drift`,
  `Max step`, `Boundary`, `D²`, `msgs/block`, plus main-thread `RAF
  p99`. Measured only when stats are open (zero overhead otherwise).
  Timing fields display `-` on platforms where `performance.now()`
  isn't available in the worklet scope (some Firefox Mobile builds);
  the signal-continuity fields always populate. Stats window
  auto-clamps into the viewport on show / drag-end / resize to avoid
  the "reload leaves window off-screen" issue on mobile.
- AudioContext constructed with `{ latencyHint: 'playback' }` for a
  larger, more forgiving output buffer (~50 ms extra latency is fine
  for a synth driven by scene geometry). Graph is
  `workletNode → master → destination` with the analyser branched
  off `master` as a passive tap (not in the live path).
- Element `_opacity` (0..1, set by `song._applyKeyframes` during
  fade-in / fade-out between keyframes) is now actually rendered:
  `renderer.drawElement` multiplies `uTintStrength`, `uEdgeGlowAmp`,
  and `uMagnitude` by `_opacity`; the overlay pass scales outline
  alpha by `_opacity`. Elements smoothly fade in/out instead of
  snapping at keyframe boundaries.
- Transient per-frame state lives on `scene.runtime` (created by
  `createScene()`): `{ micLevels, wlPerSource }`. `serializeScene`
  excludes runtime (explicit field list). `Object.assign(scene, fresh)`
  on clear/load/preset automatically replaces runtime.
- `scene.generation` is a counter incremented by `createScene()`. The
  tracer checks `scene.generation` vs `this._generation` at the top of
  `trace()`; on mismatch it self-resets all persistence (pools,
  localPolys, exitSegs, sensorPersist, secondary queue, lastTraceTime).
  This eliminates the "forgot to flush cache X" bug class for tracer
  state.
- Rays render via instanced SDF quads, not GL line primitives — width
  and soft falloff are controlled by `renderer.rayWidth` and the
  fragment shader. Segments are 12 floats; no chase-related timing
  fields.
- Element rendering is a three-pass pipeline: rays → HDR FBO →
  tonemapped blit to screen → per-element SDF distortion pass sampling
  the same HDR FBO (also tonemapped) → overlay lines. Each material
  has a `LOOK` entry in `renderer.js` controlling tint, distortion
  magnitude, falloff, edge glow, and opacity. Sharp vs soft edges come
  from `edgeWidth`; refractive distortion comes from `magnitude` and
  `falloff`. Distortion itself is opt-in via the Distort checkbox in
  the Bench toolbar dropdown (defaults off); rim glint and tint stay
  on regardless.
- HDR rendering: ray FBO is `RGBA16F` (via `EXT_color_buffer_float`)
  so additive ray sums accumulate past 1.0 in linear space. Both blit
  and element fragment shaders apply Reinhard tone-map
  (`hdr / (1 + hdr)`) when sampling the FBO so dense overlap stays
  colorful instead of clamping to white. Falls back to `RGBA8` if the
  extension is unavailable; tonemap is harmless on already-clamped
  values.
- Per-element `el.color` overrides both visuals *and* physics: renderer
  replaces tint + edge glow; tracer switches to `elementAbsorption` /
  `elementReflectance` that treat the color as a transmission filter.
  GPU tracer now also implements `el.color` physics (GLSL `colorTrans`
  matches CPU `colorTransmission`).
- Per-element `el.absorb` (default 1, range 0–50) multiplies
  Beer-Lambert absorption. CPU: `elementAbsorption` in spectrum.js.
  GPU: element texture row 0 w-channel.
- Element property schema (`docs/js/elements.js`): single source of truth
  for per-kind properties. `ELEMENTS` exports 9 kinds; `makeElement`
  in scene.js reads from it; property panel and resize/pinch in ui.js
  are schema-driven.
- Layout is a two-row / three-column grid — fixed-height toolbar on top,
  left and right panels + stage below. Toolbar stays visible always
  (raised z-index over the drawer overlays, fixed height, horizontal
  scroll on narrow widths, `overflow-y: hidden` to prevent vertical
  scrollbar).
- Bench aspect is **variable**: `scene.bench` is the source of truth
  (not `CANONICAL_BENCH`). Three presets via a toolbar Bench dropdown:
  portrait (556x900), landscape (900x556), square (900x900).
  `renderer.setBenchSize(w, h)` updates the letterbox aspect;
  `renderer.resize()` computes the largest box at that aspect that fits
  the stage in JS (pure CSS `aspect-ratio` + `max-width` broke on
  narrow mobile portrait screens). Resize never rescales elements.
  `deserializeScene` preserves saved bench size as-is; only legacy
  1600x900 scenes are rescaled.
- Touch: single pointer drags/rotates (shift-drag rotates); two
  simultaneous pointers on a selected element pinch-scale + rotate.
- Emitter ticks: short tap toggles, long-press or shift-click solos.
  Long-press uses a pending object with identity-guarded timer so stale
  timers can't fire on subsequent presses. Timing in `UI.onDown`.
- Emitter count change clears `emitter.disabled` so stale toggle
  indices don't persist across count changes.
- Inline mini-spectrum painted at each sensor tick on the canvas, drawn
  only when the right-side spectrum panel is off-screen (so it's
  always visible somewhere). Logic in `Renderer.buildOverlay`.
- Emitter 0 and sensor 0 are at the **bottom** of the bench (low
  frequency = bottom, high = top). Indices increase upward. DOM
  readout bars are top-to-bottom so bar 0 in the right panel
  corresponds to sensor N-1 (top of bench).
- Vertical frequency labels overlay the canvas left edge, one per
  emitter row, just above each tick. Labels show note names in any
  scale mode, Hz in log mode. Updated whenever count, mode, base, or
  span changes.
- Sensor count can auto-track source count via the **Sync** checkbox
  with a multiplier slider (`sensor-factor`); manual sensor-slider use
  turns sync off.
- Help button (`?`) sits at the far left of the toolbar (before the
  Add split-button). `H` / `?` key also toggles. Summarises all
  shortcuts.
- `navigator.mediaDevices` requires a secure context. `mic.enable('mic')`
  guards and throws a clear error on plain HTTP.
- `synth.setBase(hz)` rebuilds voice frequencies for all modes (not
  just chromatic). Changing the Base dropdown takes effect immediately
  in any scale.
- Synth runs as a single `AudioWorkletProcessor` ("chromavox-synth")
  in `docs/js/synth-worklet.js`. `synth.js` fetches the file, patches
  `__PARAM_DEFAULTS__` with carrier param JSON, creates a Blob URL,
  calls `addModule`. Source cached in `_WORKLET_SRC` after first load.
  `enable()` has try/catch — cleans up AudioContext on failure.
  Main thread posts `sensorBins` via `MessagePort` each frame; worklet
  reads the latest snapshot in `process()`. Eight carrier functions
  dispatched via `_CARRIERS` map (no if/else chain). Shared `ctx`
  object cached on `this._ctx` — zero allocation per `process()` call.
  Global constant maps `_SINGLE_BAND`, `_SMOOTH_SEC`, `_CARRIERS`
  live outside `process()`. Per-carrier gain smoothing time constants
  (karplus 5ms, pulse 30ms, acid 40ms, noise/FM/supersaw 60ms,
  sine 80ms) from `_SMOOTH_SEC`. Fixed-range normalization: worklet receives
  `fullScale` (`BASE_INTENSITY * sqrt(raysPer)`) via rebuild; each
  partial's bin sum is divided by `fullScale/gainK` (`gainK` = `K`
  for sine, `1` for noise/acid) to recover 0–1 micGain, then floor
  0.15, gamma 1.5, and `1/sqrt(sc * gainK)` voice scale. Sine
  partials get 1/k rolloff for neutral timbre. `tanh` soft limiter
  at ±0.8 prevents hard clipping (applied independently to both
  stereo channels). Stereo output: `outputChannelCount: [2]`,
  constant-power pan per voice (sensor 0 → left, N-1 → right,
  `cos/sin(pan * PI/2)` pan law). Sine wavetable (`fsin`): 2048-entry
  LUT with linear interpolation for sine partials and FM; noise and
  karplus use `Math.random()` per sample per voice (shared Mulberry32
  `_rng()` reserved for vocoder shared excitation and karplus note-on
  burst where inter-voice correlation is structurally impossible).
  Nine carrier modes: `sine`
  (harmonic partials, inverted bin-to-partial mapping: blue→high
  partials, red→fundamental), `noise` (unity-gain Csound `resonz`
  bandpass; `bp = (y0-y2)*(1-r²)/2`, variable Q via slider, default
  14), `acid` (PolyBLEP saw → 3-pole TPT/ZDF diode ladder filter
  with `tanh` feedback; sensor energy drives cutoff for 303-style
  squelch; Resonance + Env Amount + Cutoff + Decay + Drive sliders),
  `fm` (FM synthesis, ratio + depth), `supersaw` (7 detuned saws,
  detune slider), `pulse` (PolyBLEP variable-width pulse, Width
  slider 0.05-0.95), `vocoder` (classic vocoder: shared broadband
  excitation at 100 Hz → 4th-order bandpass per voice, 24 dB/oct;
  auto-Q from spacing, envelope applied PRE-filter; Excite/Attack/
  Release sliders), `karplus` (Karplus-Strong delay line per voice,
  Damping + Excite sliders, continuous + transient excitation), and
  `piano` (modal synthesis with 12 slightly-inharmonic partials per
  voice; rising edges in `voiceGain` inject strike energy into per-
  partial peaks, then each partial decays exponentially at its own
  rate — low partials ring long, high die fast, bass scales longer
  than treble; inharmonicity `B ∝ (261/f)²` scaled by `pnoStretch`
  slider; velocity-dependent brightness via `pnoBrightness`;
  `pnoDecay` scales ring time. Per-partial state persists between
  blocks so voices stay alive while peaks ring after `voiceGain`
  drops — the active-voice gate checks `v.pianoPeak[]` when the
  carrier is piano).
  Spectral centroid (inverted: blue→1.0, red→0.0) modulates per-
  carrier parameters (acid→cutoff, noise→freq, fm→ratio,
  supersaw→detune, pulse→duty, vocoder→Q, karplus→excitation filter,
  piano→upper-partial brightness). Carrier params defined in
  `docs/js/carriers.js`. Partials slider visible only in sine mode.
  Voices with
  all gains < 1e-5 are skipped (voice stealing). Rebuild sends
  frequency array + `fullScale` via `MessagePort`. `synth.enable()`
  is async (awaits `audioWorklet.addModule`). Log-mode voice
  frequencies use 80–6000 Hz; voice-mode uses 100–4000 Hz. Both use
  `(i+0.5)/n` bucket-center spacing matching `micBands`.
  `synth.setStep` skips rebuild for log and voice.
- Keyboard claviature voices use `'triangle'` so a single key mostly
  occupies one chromatic bucket without turning into a full harmonic
  stack like sawtooth. On key release, `_knownFrequencies` returns
  `[]` (not `null`) so `directLevels` returns an all-zeros array
  instead of falling through to the FFT path, preventing spectral
  leakage from the fading oscillator from lighting up many emitters.
- Touch/keys always active: touch zone and keyboard claviature work
  alongside any source, not only when `touch/keys` is selected.
  `_installKeyboard()` extracted, called for all sources. Touch/keys
  levels overlay on other sources via `max()`. Touch on the left edge
  of the bench (≤60px from emitter ticks, including letterbox black
  bars) sets emitter levels by Y position. Keyboard claviature
  (ZXCVBNM layout) sets by scale degree. Both write to
  `_touchTargets`; actual `_touchLevels` ramp toward targets each
  frame via `smoothTouchLevels()` (attack 0.2/frame, release
  0.15/frame). `mic.onTouchChange` callback wakes the frame loop.
  Multi-touch supported. All emitters force-enabled.
  `stopPropagation` on touch-zone pointers prevents UI drag
  interference. Element hit-test has a 15px proximity fallback for
  easier touch selection.
- UI shortcuts ignore key events while a drag is in progress
  (`if (this.dragging) return;`) so playing keyboard notes mid-drag
  doesn't hijack the gesture.
- Audio bucketing supports musical scales: `Mode` is one dropdown
  combining `log`, `voice`, and the `SCALES` keys (`chromatic`, `major`,
  `minor`, `pentaMajor`, `pentaMinor`, `wholeTone`, `blues`). `log`
  picks the broadband 80–6000 Hz path; `voice` picks a focused
  100–4000 Hz log-spaced path (same code path as log, tighter range);
  any other value names a scale walked by `scaleFreq` from `baseHz`.
  Window per bucket is the geometric midpoint between neighboring
  scale degrees, so any scale gets full coverage with no overlap.
  Span slider hidden for log and voice. `micBands` normalization is
  **split by source**: file source uses `dbToLin` (linear amplitude)
  with `_peakHold` (decays 0.95/frame), linear (no sqrt, no gamma);
  all other sources use absolute `dbNorm` (dB to 0–1 via analyser
  range), floor 0.45 for scale modes / 0.20 for log modes, noise
  gate 0.10. Worklet floor reduced to 0.02, gamma removed (linear).
- Synth side can run **independent** of the mic side via the
  `Independent scale` checkbox — separate Mode/Base/Span controls
  appear (and stay visible but **disabled / dimmed** via the
  `row-disabled` class when not active). Off (default), synth follows
  mic so input-output pitch corresponds under identity optics. Same
  treatment for the sensor `Factor` slider when `Sync to source count`
  is unchecked.
- Mic smoothing is exposed as a slider (`AnalyserNode.smoothingTimeConstant`)
  for per-keyboard-style snappy response or smoother envelope tracking.
- Toolbar's element placement is a split button — left side places the
  last-used element (shows SVG icon + label), right side (`▾`) opens
  the full dropdown. Picking from the dropdown updates the default.
  Fixed 140 px width to avoid layout shift. Label hidden on mobile
  (<=960px), shows only SVG icon. Each menu item shows an SVG
  thumbnail rendered from the element's own `localPolygon`.
- Delete is an action button (trashcan icon) — not a mode. Disabled
  when no element is selected; click deletes the selected element and
  selects the next one (or previous if last). Backspace/Delete key
  triggers the same action. No separate Select button — selection is
  always the default behavior (tap/click an element to select, tap
  empty space to deselect).
  Two-finger pinch selects the element nearest the midpoint of the
  fingers (within 60% of the finger span) if nothing is selected.
- Audio in / Audio out are split-button dropdowns: the main button
  toggles the audio state on/off; the `▾` opens an options menu
  (`#mic-menu`, `#synth-menu`) containing all the related selects /
  sliders / checkboxes. Menus are `position: fixed` so the toolbar's
  `overflow-x` doesn't clip them.
- Vertical labels exist on **both** sides of the canvas: emitter
  labels on the left edge (mic-side scale) and sensor labels on the
  right edge (synth-side scale). They diverge when Independent is on.
- `endEdit` short-circuits while `this.dragging` is set so unrelated
  events (Shift keyup, slider change) can't prematurely seal the drag's
  pending history snapshot.
- Scene auto-saves to `localStorage` on every `markDirty` (key:
  `'chromavox-scene'`). On page load, `main.js` restores from
  localStorage if available, falls back to `createScene()`. Uses
  `serializeScene` / `deserializeScene`.
- Clear button `Object.assign`s a fresh `createScene()` over the scene
  (not just `elements = []`), calls `syncControls` +
  `rebuildSensorReadout`, and removes the localStorage entry. The fresh
  `createScene()` provides a clean `scene.runtime` (micLevels,
  wlPerSource) and resets `emitter.disabled`, so no manual nulling is
  needed.
- `syncControls` dispatches `'change'` events on all 7 sliders after
  setting values programmatically so `main.js` label-rebuild listeners
  fire.
- UI constructor takes a 4th arg (`onSceneReset`), called from clear,
  file-load, and preset-load handlers. `main.js` passes `resetDisplay`
  which calls `renderer.resetReadout()` (zeros `_displayBins` and
  `_peakMax` on the Renderer instance) and
  `tracer.resetPersistence()`.
- `tracer.resetPersistence()` zeros `_exitSegCount`, `_sensorPersist`,
  clears `_pools` and `_localPolys`. Prevents stale persistence data
  from bleeding across scene transitions. The `scene.generation`
  counter also triggers the tracer to self-reset at the top of
  `trace()` on mismatch, as a safety net.
- Deleting a delay element drops its pool and flushes the persistence
  caches for that element: `_exitSegCount` is zeroed and
  `_sensorPersist` is filled with 0 so ghost exit segments and sensor
  deposits don't linger.
- Elements can have `el.spin` (rad/s). The frame loop applies
  `el.rot += el.spin * dt`. Property panel has a Spin slider
  (-180..180 deg/s) with `×` reset button. Ctrl+Left/Right adjusts
  spin by 10 deg/s. Serializes and undoes automatically.
- Mic spectrum window: floating draggable debug window toggled via
  checkbox in the left panel. Shows raw FFT curve (grey) and micBands
  bucket levels (colored bars) on a shared log-frequency axis.
- Synth spectrum window: same structure, toggled separately. Shows
  the actual FFT of the synth's audio output via an `AnalyserNode`
  tapped between the worklet and master gain. Log-frequency axis
  80–6000 Hz. Reflects real output including partials, carrier mode,
  and any clipping/limiting.
- Global settings (bench aspect, no-overlap, distort, stats, spectrum
  toggles, tracer indicator) live in a "Bench" toolbar dropdown menu,
  positioned left of Audio in. Left panel now only has: Emitters,
  Sensors, Selected.
- Stats window: floating draggable window toggled via a checkbox in the
  Bench dropdown. Shows elements, sources, sensors,
  rays/src, segments, particles, pools, spinning count, and audio stats
  (carrier, active/total voices, block size, xruns). Xrun detection via
  `currentFrame` gap checking in worklet. Close button in titlebar
  (pointerdown handler skips `.fw-close` to avoid drag capture). Updates
  every frame when visible, skips DOM writes when hidden. Text is
  selectable (`user-select: text`).
- Spectrum readout smoothing: `renderer.updateReadout(scene, tracer)`
  applies (A) Gaussian blur [0.25, 0.5, 0.25] across bins, (C) temporal
  IIR (`_displayBins` lerps at 0.3), (D) slow-decaying peak
  normalization (`_peakMax` decays at 0.95). `_displayBins`, `_peakMax`,
  and `_blurBuf` live on the Renderer instance (not module scope in
  main.js).
- Delay materials (Phase 3 stateful slow-glass): each delay element
  owns a `ParticlePool` in the tracer. Primary rays entering a delay
  element are captured (not refracted through); particles advance each
  frame, emit trail segments into the shared ray buffer, and exit as
  secondary rays. `DELAY_MIN` threshold (0.0003): below this, delay
  element is treated as a normal dielectric. Particle record is 11
  floats: `[lx, ly, ldx, ldy, I, wl, lastLx, lastLy, r, g, b]` with
  RGB pre-computed at capture. Secondary emissions stored in flat
  Float32Array (10 floats per entry). Exit segment persistence cache
  (`PERSIST_DECAY=0.80`) and persistent sensor accumulator
  (`_sensorPersist`) smooth secondary-ray deposits across frames.
  `tracer.activeParticleCount()` gates the RAF loop; `tracer.simRate`
  (log-scaled 0.05x..4x) multiplies particle advance `dt`. No chase
  clock, no onset detector, no `DelayNode`, no `delayFingerprint`.
  `History.commit` returns void; UI constructor takes 4 args
  (scene, onChange, renderer, onSceneReset).
- Delay haze visual: elements with `delayK > 0` get increased
  `tintStrength` (delayK * 80, capped at 0.5) in the renderer,
  making them look foggy. Zero-delay elements unchanged. Per-element
  `el.color` override still takes precedence.
- GPU tracer (`docs/js/gpu-tracer.js`): WebGL2 transform feedback with
  ping-pong bounce architecture. Default tracer; auto-switches to CPU
  when delay elements are added (`pickTracer()`). One TF dispatch per
  bounce, reading previous bounce's ray state from a ping-pong buffer
  pair. `effectiveBounces = min(32, segCount + arcCount * 3 + 2)` bounds
  dispatch count (arc edges get 3× for TIR; segment edges get 1×). Segment
  buffer populated via `copyBufferSubData` per bounce; renderer binds
  directly (zero-copy, stride 96, offset `SEG_P_OFF`). Inside-element
  stack: depth-3 packed into one fp32 (`stkLen*262144 + stk[0]*4096 +
  stk[1]*64 + stk[2]`). Sensor accumulation via R32F FBO + `readPixels`
  (~6 KB); requires `EXT_color_buffer_float` + `EXT_float_blend` —
  if either is absent the GPU tracer disables itself (`_ready=false`)
  and `main.js` falls back to CPU tracer (console.warn names the
  missing extension). Pre-built VAOs and TF objects (properly deleted
  on buffer resize). 33-870x faster than CPU. `trace()` postcondition:
  FBO unbound, blend/viewport/program left dirty. `?cpu` forces CPU.
  Test page: `docs/gpu-test.html`.
- Idle RAF loop: frame loop stops when nothing needs updating.
  `scheduleFrame()` wakes it; `setDirty()` wakes + retraces;
  `markDirty()` wakes + retraces + saves to localStorage. Idle check:
  `needsFrame = dirty || particlesInFlight || hasSpinning ||
  touchRamping || songPlayer.playing || mic.active || synth.active`.
  All state-changing handlers call `scheduleFrame`/`setDirty`.
- Fullscreen mode: `F` key or `⛶` button toggles. Hides toolbar, left
  panel, transport, panel toggles. Shows bench + right panel (sensor
  spectrograms). Scale labels fade to 25% opacity. Mobile (≤600 px):
  right panel hidden too. Uses Fullscreen API; exits on Escape.
- Responsive layout: three tiers — full 220px panels above 960px,
  slim 160px panels from 601–960px (foldables/small tablets), drawer
  mode below 600px (phones). `#stage` has `touch-action: none`.
