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
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, `MATERIALS` table,
  `SCALES` table + `scaleFreq(base, scale, i, stepDeg)` for musical
  bucketing.
- `docs/scene.js` — data model, local/world polygon geometry, JSON
  save/load. `createScene()` initialises `scene.runtime` (transient
  per-frame state: `micLevels`, `wlPerSource`) and increments
  `scene.generation` (used by the tracer to detect scene replacement
  and auto-reset persistence).
- `docs/raytracer.js` — CPU tracer; per-frame segment records + sensor bins.
- `docs/renderer.js` — WebGL2, three passes: (1) instanced SDF quad rays
  rendered into a **HDR `RGBA16F` FBO** via `EXT_color_buffer_float`
  (additive blend in linear space, soft falloff), (2) tonemapped blit to
  screen + per-element bounding-quad pass that re-samples the same FBO
  with a polygon-SDF-driven offset for refractive distortion and material
  tinting; both apply Reinhard tone-mapping when reading the HDR
  texture, (3) alpha-blended overlay lines for the bench outline,
  element outlines, emitter/sensor ticks, and an inline per-sensor
  mini-spectrum painted next to each sensor tick so the wavelength
  distribution is always visible on the canvas even when the right panel
  is scrolled or short.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel,
  save/load, preset dropdown, undo/redo, keyboard shortcuts.
- `docs/mic.js` — audio input (mic or synthetic source) + FFT bucket extraction.
  Filters system-realtime messages (status >= 0xF0, e.g. Active Sensing)
  before processing/logging MIDI input.
- `docs/synth.js` — additive sensor synth; single `AudioWorkletProcessor`
  ("chromavox-synth") loaded from an inline Blob URL. Main thread posts
  `sensorBins` via `MessagePort`; worklet renders 6 harmonic partials per
  voice with per-sample gain smoothing.
- `docs/push.js` — Ableton Push 2/3 integration: 8x8 RGB pixel map,
  dynamic palette management, sensor-to-pad color mapping, encoder-to-
  element dispatch, in-key layout computation, and Push display bridge.
  The Push hardware sends fixed notes 36-99; `push.js` computes
  scale-degree layout (`row * rowOffset + col`) in software via
  `fourthOffset()`. `push.setScale(scaleName)` updates row offset and
  scale length. `_connectDisplay()` streams bench canvas and sensor
  spectrogram PNGs to the display sidecar via WebSocket (retry limited
  to 5 attempts).
- `docs/main.js` — wiring + dirty-flag render loop + device pickers +
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

`main.js` uses a dirty flag. `markDirty()` is passed to `UI` as `onChange`
and called on every interaction. `markDirty` also auto-saves the scene
to `localStorage` (key `'chromavox-scene'`) via `serializeScene`. On
page load, `main.js` restores from localStorage if present, otherwise
calls `createScene()`. Don't run the tracer on every RAF
unconditionally — it's pure JS and expensive at high ray counts. When
audio in is active the loop marks dirty each frame so buckets animate;
when audio out is active the synth update also runs every frame.

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
