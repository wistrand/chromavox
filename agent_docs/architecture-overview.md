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
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
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
- `docs/synth.js` — additive sensor synth (harmonic partials driven by bins).
- `docs/main.js` — wiring + dirty-flag render loop + device pickers.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`. It
  emulates GitHub Pages' clean-URL fallback: a request for `/foo` falls
  back to `/foo.html` when `foo` doesn't exist. Containment is checked
  both on the incoming URL and on the appended/directory-index path.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`,
`bench.h`. The bench is **letterboxed** at the canonical portrait
golden-ratio aspect (`CANONICAL_BENCH` in `scene.js`); CSS pins the
canvas to that aspect inside the stage with black bars on whichever
axis the viewport over-provides. `Renderer.benchSize` returns the
constant. All UI input is converted via `UI.canvasToBench`.

Y is **down** (screen convention). Polygon winding and outward-normal sign
in `worldEdges` depend on this — see the shoelace / `cw` logic. If you
change the coordinate convention, re-derive the normal sign carefully;
getting it wrong flips refraction direction and everything breaks subtly.

## Render loop

`main.js` uses a dirty flag. `markDirty()` is passed to `UI` as `onChange`
and called on every interaction. Don't run the tracer on every RAF
unconditionally — it's pure JS and expensive at high ray counts. When
audio in is active the loop marks dirty each frame so buckets animate;
when audio out is active the synth update also runs every frame.

In addition to the dirty flag, the loop runs a **chase clock** (Phase 2,
delay-materials feature). Two clocks share an epoch (`chaseStart`):
`uTphysical` is real-time elapsed since the last re-arm and gates the
synth-facing `sensorBins`; `uTvisual` is a phase-accumulator
(`Σ dt·visualRate`) so mid-chase slider tweaks apply going forward
instead of rewinding. Re-arm triggers are: a **delay-relevant** UI
commit (via `UI.onRearm`; see the fingerprint note below), a scene load
that changes the delay fingerprint, and a peak-hold mic onset detector.
While `uTvisual < tracer.maxT` the render path runs every frame even
with no dirty flag, so the chase animates; once the wavefront has fully
drawn in, RAF idles back to dirty-driven redraws.

When `tracer.maxT === 0` (no delay element in the scene) the loop sets
`renderer.uT = 1e6` instead of `uTvisual`, so the fragment shader's
soft leading-edge fade never activates and rays render at full opacity
from the first frame — pre-Phase-2 behaviour is preserved exactly for
non-delay scenes.

The UI's re-arm fires selectively. `History.commit` returns a
`delayChanged` flag based on a `delayFingerprint(scene)` that hashes
only the delay-material elements' id / material / effective `delayK` /
position / rotation / size / color. Editing a non-delay element, or
any edit at all in a no-delay scene, leaves the fingerprint unchanged
and therefore doesn't drain the current ray image. Adding, removing,
moving, reshaping, or re-tuning a delay element flips the fingerprint
and re-arms the chase.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). The static server's ROOT is
`docs/`, which is also the folder GitHub Pages serves.
