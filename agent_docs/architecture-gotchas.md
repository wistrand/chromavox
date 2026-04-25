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
  by `createScene()` AND by `bumpGeneration(scene)` at every shape-
  change site — UI count sliders, song keyframe globals, undo/redo)
  triggers the tracer to self-reset all persistence at the top of
  `trace()` on generation mismatch, as a safety net against missed
  manual resets.
- **`scene.runtime` array sizing.** `runtime.micLevels` and any present
  `runtime.wlPerSource.{min,max}` must always be sized to
  `scene.emitter.count`. `ensureRuntimeSize(scene)` (`scene.js`) is
  the single owner — call it from any new site that mutates
  `emitter.count`. Float32Array silently no-ops out-of-bounds writes
  and returns `undefined` on out-of-bounds reads, so a size mismatch
  produces NaN downstream, not an error: any consumer using these
  values (tracer wavelength integration, edge-memory color pickup,
  GPU-tracer texture upload) will silently corrupt with NaN that
  propagates through additive blending into the HDR FBO and the
  Reinhard tonemap squashes the whole bench to black. The frame loop
  calls `ensureRuntimeSize` once per frame as a floor.
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
- **Shader-time modulation: integrate velocity, don't multiply
  position.** A natural-looking formulation of "drift with oscillating
  speed" looks like `p += t * v0 * (1 + k*sin(w*t))`, but its time
  derivative contains `t * v0 * k * w * cos(w*t)` — linear in `t`, so
  the effective drift rate grows without bound as the page stays
  open. This is what caused the smoke to appear to "speed up after a
  while." The correct form is the integral of the intended velocity
  `v(t) = v0 * (1 + k*sin(wt + φ))`, i.e.
  `p(t) = v0*t + (v0*k/w) * (cos(φ) - cos(wt + φ))`. Bounded
  derivative forever. Rule of thumb: if you want a quantity's *rate*
  to oscillate, write `p(t) = v0*t + amp * (1 - cos(wt))` directly,
  not `t * v0 * (1 + k*sin(wt))`.
- **Edge memory accumulators are row-index-keyed.** `_emitterGlow[i]`
  / `_sensorGlow[s]` only have meaning relative to the *current*
  `emitter.count` / `sensorCount`. The renderer guards this with a
  generation+dimension tripwire at the top of `updateEdgeGlow` —
  reset on `scene.generation` change OR on emitter/sensor count
  change. Don't add new persistence keyed by emitter/sensor index
  without applying the same pattern (see `_glowGen`,
  `_glowEmitterCount`, `_glowSensorCount` in `renderer.js`).
- **Edge memory shader clamps `max(vec3(0), uGlowCol[i])`.** A single
  negative or NaN value uploaded to the additive HDR FBO (no clamp,
  blend `ONE+ONE`) would dominate the bench and tonemap to black.
  CPU-side guards are belt-and-suspenders — the shader clamp is the
  load-bearing one. Don't remove it.

## Drag-and-drop / file import

- **Firefox + Linux Wayland delivers an empty `DataTransfer` to the
  drop event** when a file is dragged from a Wayland-native file
  manager onto an HTTP page. `dt.files`, `dt.items`, `dt.types`,
  every `getData()` call — all empty. Chrome bundles its own DnD
  layer and isn't affected. The page bytes simply aren't reachable
  from JS; no JS-side workaround can recover them. Fixes (in order
  of effectiveness): (1) launch with `MOZ_ENABLE_WAYLAND=0 firefox`
  to force the X11 backend; (2) toggle
  `dom.events.dataTransfer.protected.enabled` in `about:config`;
  (3) set `privacy.resistFingerprinting = false`. The drop handler
  in `main.js` opens the file picker as a fallback when it sees an
  empty DataTransfer, so users hit one extra click instead of total
  failure.
- **Drop-handler quirks.** Drag handlers are bound on `document` (not
  `stage`) because Firefox can ignore a bubbled `dragover.preventDefault()`
  from an ancestor when the immediate target is a WebGL canvas, and
  refuse to fire `drop`. Document-level binding guarantees
  preventDefault is registered for the immediate target's ancestor
  chain regardless of which sub-element is under the pointer. Don't
  preventDefault the `dragenter` event in Firefox — for cross-origin
  (file://) drag sources, that causes the subsequent `drop` to
  deliver an empty `DataTransfer`.
- **Autoplay across `await` in Firefox.** Firefox invalidates the
  user-activation token across async boundaries, so a synthetic
  `playBtn.click()` issued *after* `await importSongFile(f)` can't
  unlock the AudioContext — the play handler runs but
  `synth.enable()` / `AudioContext.resume()` silently fail. The drop
  handler pre-warms `synthBtn.click()` synchronously before the
  await, then inlines the play sequence (no synthetic click) after
  the song loads.
