# Architecture: Known Gotchas

## Rendering

- `gl.lineWidth` is driver-clamped to 1 px on nearly all WebGL
  implementations. Rays avoid this by rendering as instanced SDF
  quads (`docs/js/renderer.js`). Overlay elements (bench outline,
  emitter/sensor ticks, element polygons, per-sensor mini-spectrum)
  still use line primitives; emitter ticks stack a few parallel 1 px
  lines vertically to look thicker.
- Additive blending is the right model for accumulated light. With
  the HDR ray FBO (`RGBA16F` + Reinhard tone-mapping) channels can
  freely sum past 1.0 and get compressed softly on display, so dense
  overlap stays colorful rather than clamping to white. The fallback
  path (when `EXT_color_buffer_float` isn't available) clamps at 1.0
  before the tonemap and exhibits the old neon-white-on-overlap
  behaviour.
- Element interiors are drawn as bounding-box quads; the fragment
  shader runs a polygon-SDF loop up to `MAX_EDGES` (defined in
  `docs/js/renderer.js`) to clip and sample the underlying ray FBO with
  a distortion offset. Polygons with more edges than that will be
  silently clipped — bump `MAX_EDGES` (and verify the uniform array
  fits within the GPU's component limit) if you add a new element
  shape that needs more vertices than the current circle (128).

- `preserveDrawingBuffer` is **not** set. The Push display uses an
  `onPreOverlay` hook that calls `gl.readPixels` mid-draw (between the
  element pass and the overlay pass), before the compositor can clear
  the backbuffer. This avoids the per-frame extra blit cost that
  `preserveDrawingBuffer` imposed.

- **Adaptive quality and the idle RAF loop**. `renderer.updateQuality`
  samples frame-to-frame deltas into a 30-entry rolling window.
  Chromavox's RAF loop intentionally parks when nothing changes, so
  the first frame after a wake (user edit, tab refocus, mic enable)
  naturally measures the idle duration — potentially seconds. Two
  guards prevent a spurious tier jump: (a) per-frame delta is clamped
  to 200 ms before being pushed into the window; (b) `_qFrameTimes`
  is cleared whenever the tier changes, so recovery isn't lagged by
  stale data at the previous tier. Without these, tier 2+ triggers
  the "bezel" disappearing bug — the per-element SDF pass is
  completely skipped (`renderer.js` guard at `if (this.qualityTier <
  2)`), leaving only the overlay outline lines.

## Physics

- `hyper` and `diamond` materials illustrate the `n < 2` TIR
  constraint on a 60° prism — don't mistake internal bouncing for a
  physics bug. See `architecture-raytracer.md`.
- Block zigzag is also real physics: adjacent faces of a rectangular
  dielectric always TIR, so rays can only exit through the parallel
  opposite face.
- Overlapping dielectrics work (inside-element stack resolves `n1` /
  `n2` and Beer-Lambert α correctly), but the stack uses
  *last-entered* as the current medium. For deliberately ambiguous
  overlaps, the picked medium depends on which element the ray
  entered first.

## Phase 3 particle simulation

- A delay element's pool is keyed by `el.id`. Deleting the element
  drops the pool entirely — in-flight photons vanish — and flushes
  persistence caches (`_exitSegCount` zeroed, `_sensorPersist` filled
  with 0) so ghost segments and sensor deposits don't linger.
- Particles are stored in element-local coordinates. Moving /
  rotating / scaling the element carries held light with it by
  construction. World-space transforms happen only at trail-emission
  and exit refraction.
- Single-attachment rule: a particle belongs to the element it
  entered. Overlapping another delay element mid-flight does NOT
  re-attach. Chained delay materials work *after* the first particle
  exits and its secondary ray re-captures into the new element.
- Exit edge detection uses `segSegT` on the advance step against
  every local polygon edge. If the step somehow overshoots without a
  detected crossing (numerical edge case, e.g. a tangent grazing),
  the particle is dropped. At typical speeds this never triggers.
- The main-loop idle gate is `tracer.activeParticleCount() > 0 ||
  dirty`. If you add other stateful subsystems that need per-frame
  stepping, fold them into the same gate or RAF will idle.
- `simRate` scales the advance `dt` but does **not** scale mic input
  sampling or the primary ray pass. It only affects time *inside* a
  delay material.
- `DELAY_MIN` threshold (0.0003): elements with `delayK` below this
  are treated as normal dielectrics — no particle capture. This
  prevents near-zero delay values from triggering the particle path
  unnecessarily.
- Exit segment persistence cache and persistent sensor accumulator
  (`PERSIST_DECAY = 0.80`) smooth secondary-ray output. If you see
  "ghosting" of exit segments or sensor energy after input stops, this
  is the decay tail, not a bug.

## Audio

- `synth.js`: acid voice `smoothCutoff` initialized to `-1` sentinel,
  seeded to `baseCutoffHz` on first activation. Previously was 0,
  causing `tan(0)=0` and a silent first block.
- `main.js`: `synth.setBase(NaN)` guard when source is touch/file
  (missing from `baseBySource` map).
- `mic.js`: `_peakHold` reset to 0 in `enable()` to avoid stale
  values across source switches.
- `mic.js`: `disable()` clears `_touchTargets` so stale touch state
  doesn't persist across source switches.
- `mic.js`: `_installKeyboard` uses `setTouchLevel()` not direct
  `_touchLevels` write, so the touch smoothing ramp runs correctly.
- `mic.js`: `_decodedFile` persists across `disable()` cycles so file
  audio can resume without re-picking.
- `raytracer.js`: secondary ray `skipElId` stored in separate
  `_secondarySkipIds[]` array (UUID strings can't go in Float32Array).
- Visibility change handler now suspends AND resumes both mic and synth
  AudioContexts.
- Concave lens arc angle fix: `a0 = pi-alpha, a1 = pi+alpha` (was
  swapped, giving ~300 degree span).
- `synth.setBase()` rebuilds voices for all modes. Previously it
  only rebuilt for chromatic, so changing Base in major/minor/etc
  had no effect until a mode switch forced a rebuild.
- Chromatic mode range equals `count × stepSemi` semitones — bump
  count or widen Span to see more of the input spectrum.
- `AudioContext.setSinkId()` is not supported in older browsers; the
  app silently falls back to the system-default audio output.
- Mic stream requests disable AGC / AEC / NS in the constraints. On
  Linux/PipeWire some drivers still apply processing out of our
  control; verify with OS tools like `pavucontrol`.
- `navigator.mediaDevices` is only defined in a **secure context** —
  HTTPS or `localhost`. Plain HTTP on a LAN hostname leaves it
  `undefined`, so `mic.enable('mic')` throws a clear guard error
  instead of crashing. Workarounds: serve over HTTPS (e.g. `ngrok`,
  `cloudflared`), flip the browser's "treat insecure origin as
  secure" override flag (Chrome:
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`; Firefox:
  `about:config` `media.devices.insecure.enabled` and
  `media.getusermedia.insecure.enabled`), or pick a synthetic source
  (sine / harmonics / noise / keyboard) which doesn't need
  `mediaDevices`.

## Rendering (cont.)

- Renderer caps instanced segment draws at 500K instances
  (`Math.min(segCount, 500000)` in `drawArraysInstanced`). Scenes
  with extreme ray counts can hit this silently — segments beyond the
  cap are not drawn.

## Synth

- Sine wavetable (`fsin`): 2048-entry LUT with linear interpolation
  for sine partials and FM. Noise and karplus use `Math.random()` — a
  deterministic PRNG (Mulberry32) was tried and reverted because it
  caused audible inter-voice correlation artifacts.
- Karplus excitation uses `>= 0.05` threshold for transient detection
  (not `>`). The Excite slider blends between continuous (bowed) and
  transient-only (plucked) modes.
- `synth.js`: `enable()` has try/catch around fetch + addModule —
  cleans up AudioContext on failure to prevent leaked contexts.
- `synth-worklet.js`: vocoder stores `env` (not `voiceTarget`) in
  `v.gains[0]` for correct envelope tracking.
- Centroid smoothing uses block-rate coefficient
  (`1 - (1 - smooth)^blockLength`), not per-sample. This gives the
  correct smoothing time constant regardless of block size. Applying
  the per-sample coefficient once per block would under-smooth.

## UI / state

- Slider sanity: nothing prevents `wlMin > wlMax`; the tracer handles
  it but the output gets weird.
- Large ray counts are capped by the slider max in
  `docs/play.html`. The per-segment buffer can balloon at high
  counts; watch for perf drops on low-end mobile.
- The element material dropdown filters by element kind
  (`dielectric` / `mirror`); switching a mirror to a dielectric is
  not exposed in the UI — change via JSON edit if needed.
- Bench aspect is variable (`scene.bench` is source of truth). Three
  presets: portrait (556x900), landscape (900x556), square (900x900).
  `renderer.setBenchSize(w, h)` updates the letterbox aspect.
  `renderer.resize()` computes the viewport size in JS — don't revert
  this to pure CSS `aspect-ratio` + `max-width`; the CSS approach
  breaks on narrow mobile portrait screens (height: 100% wins over
  the aspect ratio when max-width clamps). Resizing the window does
  not move any element; the stage just shows more or less black bar.
  `deserializeScene` preserves saved bench size as-is; only legacy
  1600x900 scenes are rescaled.
- Toolbar has a fixed height with `box-sizing: border-box`,
  `overflow-x: auto`, and `overflow-y: hidden`; on narrow viewports
  the horizontal scrollbar appears inside the bar rather than
  compressing it.
- Scene auto-saves to `localStorage` on every `markDirty`. If
  localStorage is unavailable (private browsing, quota exceeded) the
  save silently fails; the app still works.
- `tracer.resetPersistence()` must be called on scene transitions
  (clear, load, preset) to avoid stale exit-segment and sensor
  persistence data bleeding into the new scene. The `onSceneReset`
  callback handles this. Additionally, `scene.generation` (incremented
  by `createScene()`) triggers the tracer to self-reset all persistence
  at the top of `trace()` on generation mismatch, as a safety net
  against missed manual resets.
- Changing the emitter count clears `emitter.disabled` so stale
  toggle indices from a previous count don't persist. On clear/load,
  the fresh `createScene()` provides a clean `emitter.disabled`
  automatically.
- Deleting a delay element drops its pool and flushes the persistence
  caches (`_exitSegCount` zeroed, `_sensorPersist` filled with 0) so
  ghost exit segments and sensor deposits don't linger.
- Elements with `el.spin` keep the render loop active even when
  nothing else is dirty. If spin is set to zero the element stops
  marking dirty.
- **Flexbox / grid `min-width: auto` inflation.** Both grid items and
  flex items default to `min-width: auto`, which is their content's
  *intrinsic* size. On mobile the canvas's intrinsic dimension is
  `width = canvas.w · dpr` — easily 1000-2400 px — so #stage (grid
  item) and #bench-viewport (flex item) were being forced wider than
  the viewport by the canvas's pixel-resolution attributes, manifesting
  as "bench clipped on the right" with no top/bottom letterbox.
  Affected elements need `min-width: 0; min-height: 0` explicitly:
  `#stage`, `#bench-viewport`, `#toolbar`, `#transport`, plus
  `min-width: 0` on `#gl`. If you add another grid or flex element
  that contains a large-intrinsic-size child (canvas, image), add
  `min-width: 0` preemptively or the layout will creep back to
  overflowing on narrow screens.
- Labels (`#emitter-labels`, `#sensor-labels`) and GL-drawn wall
  markers (`renderer.showTicks`) both auto-hide at `@media (max-width:
  600px)` (drawer mode). The Labels checkbox is CSS-only and matters
  only at larger widths; the Markers checkbox goes through a JS
  `matchMedia` gate: `showTicks = ticksCheckbox.checked && !narrowMql.matches`.
  If you add new mobile breakpoints or rename the 600 px threshold,
  update both the CSS query and the `matchMedia` pattern in main.js.
