# Architecture: Overview

Optical synthesizer in the browser. Audio input modulates a row of light
emitters on the left wall; an additive synth on the right wall plays back
whatever reaches the sensors; placeable optical elements in between reshape
the audio's pitch mapping, timbre, and spatial routing. Under the audio
framing is a real 2D optics simulation. Plain HTML + ES modules + WebGL2.
No dependencies.

## Module layout

- `docs/index.html` — static landing page (centered logo, no links).
  Independent of the app.
- `docs/play.html`, `docs/style.css` — the app shell: a two-row /
  three-column grid with a fixed-height top toolbar; side panels slide
  in as drawers on the mobile breakpoint (see the `@media` rule in
  `docs/style.css` for the cutoff).
- `docs/js/spectrum.js` — Dan-Bruton wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, `MATERIALS` table,
  `SCALES` table + `scaleFreq(base, scale, i, stepDeg)` for musical
  bucketing.
- `docs/js/elements.js` — single source of truth for per-kind element
  properties. Exports `ELEMENTS` (9 kinds) and `ELEMENT_KINDS`.
  Each kind: `label`, `material`, optional `materials`, `props`
  (ordered descriptors with label/min/max/default/step/type/display/
  toInternal/fromInternal/resetable), `resize`, `pinch`. Shared
  templates: `SPIN`, `ABSORB`, `DELAY`, `COLOR`. Consumed by
  `makeElement` in scene.js, property panel in ui.js, resize/pinch
  in ui.js. `LABEL_BY_KIND` derived from `ELEMENTS[kind].label`.
- `docs/js/scene.js` — data model, local/world polygon geometry, JSON
  save/load. `makeElement` reads defaults from the `ELEMENTS` schema
  in `elements.js`. `createScene()` initialises `scene.runtime`
  (transient per-frame state: `micLevels`, `wlPerSource`) and
  increments `scene.generation` (used by the tracer + renderer
  edge-memory to detect scene replacement and auto-reset persistence).
  Exports `bumpGeneration(scene)` and `ensureRuntimeSize(scene)` — the
  paired single-owner helpers called at every shape-change site to
  keep runtime arrays co-sized with `emitter.count`. `localAABB(el)`
  is a zero-allocation alternative to `localPolygon` for hot paths
  that only need bounds (notably the per-frame smoke source packer).
- `docs/js/raytracer.js` — CPU tracer; per-frame segment records + sensor bins.
- `docs/js/renderer.js` — WebGL2, three passes: (1) instanced SDF quad rays
  rendered into a **HDR `RGBA16F` FBO** via `EXT_color_buffer_float`
  (additive blend in linear space, soft falloff). When
  `renderer.smokeEnabled` is true, a separate **pre-pass** writes an
  animated simplex-FBM smoke into its own RGBA8 texture — RGB = cool
  blue-grey haze, **A = normalized density**; the HDR ray FBO stays
  rays-only. Scene elements and recent pointer taps contribute to a
  per-frame **smoke source list** (`renderer.updateSources(scene)`).
  Each source carries two independent scalars — `pushK` (radial) and
  `swirlK` (tangential, signed). Elements emit 2-3 sources along
  their long axis (from the local polygon AABB) with anisotropic
  elliptic falloff rotated to match the element;
  `pushK = K_ELEM_STRENGTH / √N`, and `swirlK = el.spin · K_SPIN_SWIRL / √N`
  so a spinning element stirs the smoke in the same direction as its
  rotation while a stationary one just pushes smoke radially. Pointer
  sources set `pushK = K_PTR_STRENGTH · fade` and `swirlK = 0`; the
  outward push tracks the pointer live while held, then fades
  exponentially over ~0.35 s once released. Sources are packed into a pooled
  `Float32Array(48 × 8)` and uploaded via one `gl.uniform4fv` as
  `vec4 uSources[96]`; `renderer.hasActivePointers` keeps the RAF
  loop alive while swirls decay. The smoke shader accumulates these
  in bench space, scales into FBM-input space, and adds them to the
  ambient noise-domain-warp so smoke visibly parts around elements
  and swirls under fingers. When smoke is off both the source
  packing and GPU loop are skipped entirely. When smoke is on, a
  **two-pass separable Gaussian** runs
  on a half-resolution `RGBA16F` ping-pong (`bloomTexA` → `bloomTexB`)
  — horizontal then vertical, 9-tap kernel, 1.6-texel tap spacing
  ≈ 24 px halo at full res. HDR preserved end-to-end so bright ray
  pile-ups bloom in their true color before the final Reinhard squash.
  An optional **edge memory** pass writes per-emitter / per-sensor
  point-source glow into the HDR FBO right before the ray pass —
  exponential smoothing of `(emitterColor × micLevel)` on the left
  wall and the wavelength-weighted average of sensor bins on the
  right. Each row contributes one radial source at `(0, y_i)` /
  `(benchW, y_j)`; up to 32 brightness-thresholded rows are packed and
  uploaded as `vec2 uGlowPos[]` + `vec3 uGlowCol[]`. Time constant
  (`edgeGlowTau`) and falloff radius (`edgeGlowBandWidth`) are
  user-tunable. Self-resets via a generation/dimension tripwire at
  the top of `updateEdgeGlow` so per-row state never carries across a
  scene-shape change. The shader clamps `max(vec3(0), uGlowCol[i])`
  per source as cheap insurance against any negative roundoff in the
  EMA — the additive HDR FBO has no clamp of its own, so a single
  bad value would otherwise dominate the bench.
  (2) Tonemapped blit to screen + per-element bounding-quad pass that
  re-samples the ray FBO with a polygon-SDF-driven offset for
  refractive distortion. Both apply Reinhard tone-mapping. When smoke
  is enabled, both shaders produce
  `smokeRGB + reinhard(rays) · mix(0.5, 1.0, density) + reinhard(bloom) · density`
  — so dense smoke both lights rays up and gives them a smooth
  Gaussian bloom halo (Tyndall/laser-in-fog look). Element interiors
  deliberately skip the smoke + bloom composition and just show
  `reinhard(rays_at_refracted_uv)` — the glass reads as a clean
  light pipe with no atmosphere inside, so fog never leaks through
  the body and rays through the lens don't carry a halo. (3) Alpha-blended overlay lines for the bench outline,
  element outlines, emitter/sensor ticks, and an inline per-sensor
  mini-spectrum painted next to each sensor tick so the wavelength
  distribution is always visible on the canvas even when the right
  panel is scrolled or short.
- `docs/js/ui.js` — pointer events (mouse + touch unified), property panel,
  save/load, preset dropdown, undo/redo, keyboard shortcuts.
- `docs/js/input.js` — owns every input source that drives emitter
  levels: microphone, audio file playback, MIDI (notes + MPE
  slide/bend), touch (pointer events on the bench's left wall),
  keyboard polyphony, and synthetic audio sources (sine, harmonics,
  white/pink noise). Provides FFT bucket extraction (`micBands`) for
  audio sources and `directLevels()` for deterministic ones.
  Filters system-realtime messages (status >= 0xF0, e.g. Active
  Sensing) before processing/logging MIDI input.
- `docs/js/synth.js` — additive sensor synth (~190 lines); main-thread
  API (enable, disable, rebuild, setCarrier, setBase, etc.) and
  MessagePort plumbing. Fetches the worklet source from
  `synth-worklet.js`, patches `__PARAM_DEFAULTS__` with carrier
  parameter JSON, creates a Blob URL, and calls `addModule`. Cached
  after first load (`_WORKLET_SRC`). Try/catch cleans up AudioContext
  on fetch/addModule failure.
- `docs/js/synth-worklet.js` — the `AudioWorkletProcessor`
  ("chromavox-synth"). Eight standalone carrier functions dispatched
  via `_CARRIERS` map. Shared `ctx` object (cached on `this._ctx`,
  zero allocation per `process()` call). Global constant maps
  `_SINGLE_BAND`, `_SMOOTH_SEC`, `_CARRIERS` outside `process()`.
  Stereo output with constant-power panning. 2048-entry sine
  wavetable (`fsin`) with linear interpolation for sine partials
  and FM.
- `docs/js/midi-devices/push.js` — Ableton Push 2/3 integration: 8x8 RGB pixel map,
  dynamic palette management, sensor-to-pad color mapping, encoder-to-
  element dispatch, in-key layout computation, and Push display bridge.
  The Push hardware sends fixed notes 36-99; `push.js` computes
  scale-degree layout (`row * rowOffset + col`) in software via
  `fourthOffset()`. `push.setScale(scaleName)` updates row offset and
  scale length. `_connectDisplay()` streams bench canvas and sensor
  spectrogram PNGs to the display sidecar via WebSocket (retry limited
  to 5 attempts).
- `docs/js/midi-devices/akai-mpc.js` — Akai MPC Live II / One / X integration: 4x4
  RGB pads via SysEx, Q-Link encoders, jog wheel. See
  `architecture-akai-controllers.md`.
- `docs/js/midi-devices/akai-apc.js` — Akai APC Mini MK2 / APC64 integration: 8x8
  RGB pads via SysEx (with palette fallback), faders with pickup mode,
  in-key layout matching Push. See `architecture-akai-controllers.md`.
- `docs/js/midi-devices/keyboard.js` — generic MIDI keyboard fallback:
  no LEDs, no display, linear `note - mic._kbdMidiBase` pad mapping.
  Its `static matches()` always returns true, so the router picks it
  when no specific controller matches.
- `docs/js/midi-devices/router.js` — `MidiRouter`: owns singleton
  instances of all four devices, dispatches by name via each device's
  `static matches(name)`, and copies the active device's `padMapper`
  to `mic._padMapper`. main.js talks to this one object instead of
  branching on controller type.
- `docs/js/carriers.js` — carrier parameter descriptors (UI, persistence,
  automation, worklet defaults). Single source of truth for all
  carrier modes.
- `docs/js/song.js` — `SongPlayer` class and keyframe-driven playback.
  Mutates `scene.elements` in place each frame (preserves per-element
  accumulated state — `el.rot` from the spin integrator — across the
  lerp). Skips rotation lerp for elements with `el.spin`.
- `docs/js/musicxml.js` — runtime MusicXML → Chromavox song JSON
  converter (~200 lines). Zero deps, uses built-in `DOMParser`.
  Handles chords, ties, backup/forward, per-measure divisions, ABC-
  style backslash-diacritic escapes in titles. Multi-part merging
  (unions all `<part>` note streams). Auto-selects the `piano`
  carrier when score metadata mentions "piano".
- `docs/js/main.js` — wiring + dirty-flag render loop + device pickers +
  localStorage persistence (auto-save on `markDirty`, restore on load).
  Spectrum readout smoothing (`_displayBins`, `_peakMax`, `_blurBuf`)
  lives on the `Renderer` instance, updated via
  `renderer.updateReadout(scene, tracer)` and reset via
  `renderer.resetReadout()`.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`. It
  emulates GitHub Pages' clean-URL fallback: a request for `/foo` falls
  back to `/foo.html` when `foo` doesn't exist. Containment is checked
  both on the incoming URL and on the appended/directory-index path.
  `--push-display` flag spawns `tools/push-display.js` as a child
  process. Port argument only picks up numeric argv (skips flags).
- `tools/push-display.js` — Node.js sidecar that bridges WebSocket
  (port 9100) to Push USB display. Dependencies: `usb`, `pngjs`, `ws`
  (`tools/package.json`). See `agent_docs/architecture-push.md`.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`,
`bench.h`. The bench aspect is **variable**: `scene.bench` is the source
of truth (not a fixed constant). Three presets are available via a toolbar
dropdown: portrait (556x900), landscape (900x556), square (900x900).
`renderer.setBenchSize(w, h)` updates the letterbox aspect;
`renderer.resize()` computes the largest box at the current aspect that
fits the stage and sizes `#bench-viewport` explicitly (pure CSS
`aspect-ratio` + `max-width` broke on narrow mobile portrait screens).
`deserializeScene` preserves saved bench size as-is; only legacy
1600x900 scenes are rescaled. All UI input is converted via
`UI.canvasToBench`.

Y is **down** (screen convention). Polygon winding and outward-normal sign
in `worldEdges` depend on this — see the shoelace / `cw` logic. If you
change the coordinate convention, re-derive the normal sign carefully;
getting it wrong flips refraction direction and everything breaks subtly.

## Render loop

`main.js` uses a dirty flag and an **idle RAF loop** — the loop stops
when nothing needs updating and wakes on demand. Three-tier scheduling:

- `scheduleFrame()` — wake the RAF loop (display-only, e.g. stats)
- `setDirty()` — also retrace rays on the next frame
- `markDirty()` — also save to localStorage and pause song keyframes

`markDirty()` is passed to `UI` as `onChange` and called on every
interaction. On page load, `main.js` restores from localStorage if
present, otherwise calls `createScene()`. At the end of each frame the
idle check decides whether to request another:
`needsFrame = dirty || particlesInFlight || hasSpinning || touchRamping
|| songPlayer.playing || (mic.active && source !== 'touch') || synth.active
|| renderer.smokeEnabled || renderer.hasActivePointers
|| renderer.edgeGlowEnabled`.
All state-changing event handlers (mic enable/disable, file transport,
song play/stop/seek, synth enable, visibility resume, keyboard shortcuts)
call `scheduleFrame()` or `setDirty()` as appropriate.

Elements with `el.spin` (rad/s) get `el.rot += el.spin * dt` applied
each frame, which also marks dirty so the loop stays active while any
element is spinning.

Delay materials (Phase 3) add a stateful simulation layer on top. Each
delay element owns a `ParticlePool` in the tracer; primary rays that
cross a delay-material boundary are captured (stored as photon records
in element-local coordinates) instead of refracting through. Each
frame the tracer advances every pool by real wall-clock `dt`
(optionally scaled by the **Sim rate** slider), decays intensity,
finds any particle that crossed a local polygon edge, refracts it at
exit, and re-emits it as a secondary ray into the same `castRay`
pipeline. Every advance step also pushes one short trail segment into
the shared ray buffer so the interior of the glass is drawn by the
same shader as the ribbons outside.

A `DELAY_MIN` threshold (0.0003) prevents near-zero delay values
from triggering the particle path — below this, the element is
treated as a normal dielectric.

Exit segments from secondary rays and sensor deposits from secondary
rays are smoothed via persistence caches (`PERSIST_DECAY = 0.80`)
and a persistent sensor accumulator (`_sensorPersist`), both decayed
each frame.

`tracer.activeParticleCount()` is the idle gate. The render loop
re-traces whenever the scene is `dirty` **or** any pool holds
particles, and otherwise lets RAF idle. Non-delay scenes never
populate a pool, so their cost is exactly the same as before Phase 3
aside from one property check in the ray hot loop.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). The static server's ROOT is
`docs/`, which is also the folder GitHub Pages serves.
