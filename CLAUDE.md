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
- [GPU tracer](agent_docs/architecture-gpu-tracer.md)
- [Ping-pong tracer plan](agent_docs/plan-pingpong-tracer.md)
- [Song format design](agent_docs/design-song-format.md)
- [Known gotchas](agent_docs/architecture-gotchas.md)


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
  the left panel (below Selected, above Stats; defaults off); rim glint
  and tint stay on regardless.
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
- Layout is a two-row / three-column grid — fixed-height toolbar on top,
  left and right panels + stage below. Toolbar stays visible always
  (raised z-index over the drawer overlays, fixed height, horizontal
  scroll on narrow widths, `overflow-y: hidden` to prevent vertical
  scrollbar).
- Bench is **letterboxed** at the canonical portrait golden-ratio aspect
  (`CANONICAL_BENCH` in `scene.js`). `Renderer.benchSize` returns the
  constant; `renderer.resize()` computes the largest 556:900 box that
  fits the stage in JS (pure CSS `aspect-ratio` + `max-width` broke on
  narrow mobile portrait screens). Resize never rescales elements.
  `deserializeScene`
  rescales loaded preset coords + sizes to the canonical bench so older
  presets keep composing correctly.
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
  loaded from an inline Blob URL — no separate file, no build step.
  Main thread posts `sensorBins` via `MessagePort` each frame; worklet
  reads the latest snapshot in `process()`. Per-sample gain smoothing
  (~60 ms time constant) inside the worklet replaces the old
  `setTargetAtTime` calls. Fixed-range normalization: worklet receives
  `fullScale` (`BASE_INTENSITY * sqrt(raysPer)`) via rebuild; each
  partial's bin sum is divided by `fullScale/gainK` (`gainK` = `K`
  for sine, `1` for noise/acid) to recover 0–1 micGain, then floor
  0.15, gamma 1.5, and `1/sqrt(sc * gainK)` voice scale. Sine
  partials get 1/k rolloff for neutral timbre. `tanh` soft limiter
  at ±0.8 prevents hard clipping. Three carrier modes: `sine`
  (harmonic partials), `noise` (unity-gain Csound `resonz` bandpass;
  `bp = (y0-y2)*(1-r²)/2`, Q=25), `acid` (PolyBLEP saw → 3-pole
  TPT/ZDF diode ladder filter with `tanh` feedback; sensor energy
  drives cutoff for 303-style squelch; Resonance + Env Amount
  sliders). Partials slider visible only in sine mode. Voices with
  all gains < 1e-5 are skipped (voice stealing). Rebuild sends
  frequency array + `fullScale` via `MessagePort`. `synth.enable()`
  is async (awaits `audioWorklet.addModule`). Log-mode voice
  frequencies use the same 80–6000 Hz range and `(i+0.5)/n` bucket-
  center spacing as `micBands`.
- Keyboard claviature voices use `'triangle'` so a single key mostly
  occupies one chromatic bucket without turning into a full harmonic
  stack like sawtooth. On key release, `_knownFrequencies` returns
  `[]` (not `null`) so `directLevels` returns an all-zeros array
  instead of falling through to the FFT path, preventing spectral
  leakage from the fading oscillator from lighting up many emitters.
- Touch/keys source (default): combined touch + keyboard, no
  AudioContext. Touch on the left edge of the bench (≤60px from
  emitter ticks, including letterbox black bars) sets emitter levels
  by Y position. Keyboard claviature (ZXCVBNM layout) sets by scale
  degree. Both write to `_touchLevels`. Multi-touch supported. All
  emitters force-enabled. `stopPropagation` on touch-zone pointers
  prevents UI drag interference. Element hit-test has a 15px
  proximity fallback for easier touch selection.
- UI shortcuts ignore key events while a drag is in progress
  (`if (this.dragging) return;`) so playing keyboard notes mid-drag
  doesn't hijack the gesture.
- Audio bucketing supports musical scales: `Mode` is one dropdown
  combining `log` with the `SCALES` keys (`chromatic`, `major`,
  `minor`, `pentaMajor`, `pentaMinor`, `wholeTone`, `blues`). `log`
  picks the broadband path; any other value names a scale walked by
  `scaleFreq` from `baseHz`. Window per bucket is the geometric
  midpoint between neighboring scale degrees, so any scale gets full
  coverage with no overlap. `micBands` uses `getFloatFrequencyData`
  (dB) mapped to 0–1 via the analyser's fixed dB range (`dbNorm`),
  peak per bucket, floor 0.08, gamma 1.5, noise gate 0.10. No
  per-frame peak-hold normalization.
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
  Fixed 140 px width to avoid layout shift. Each menu item shows an SVG
  thumbnail rendered from the element's own `localPolygon`.
- Delete is an action button (not a mode). Disabled when no element is
  selected; click deletes the selected element and selects the next one
  (or previous if last). Backspace/Delete key triggers the same action.
  No separate Select button — selection is always the default behavior
  (tap/click an element to select, tap empty space to deselect).
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
- Stats window: floating draggable window toggled via a checkbox in the
  left panel (below Distort). Shows elements, sources, sensors,
  rays/src, segments, particles, pools, and spinning count. Close button
  in titlebar (pointerdown handler skips `.fw-close` to avoid drag
  capture). Updates every frame when visible, skips DOM writes when
  hidden.
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
- GPU tracer (`docs/gpu-tracer.js`): WebGL2 transform feedback with
  ping-pong bounce architecture. Default tracer; auto-switches to CPU
  when delay elements are added (`pickTracer()`). One TF dispatch per
  bounce, reading previous bounce's ray state from a ping-pong buffer
  pair. `effectiveBounces = min(32, edges+1)` bounds dispatch count
  analytically — empty scene: 1 dispatch, single prism: 4. Segment
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
- Responsive layout: three tiers — full 220px panels above 960px,
  slim 160px panels from 601–960px (foldables/small tablets), drawer
  mode below 600px (phones). `#stage` has `touch-action: none`.
