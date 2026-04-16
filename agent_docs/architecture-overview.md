# Architecture: Overview

Optical synthesizer in the browser. Audio input modulates a row of light
emitters on the left wall; an additive synth on the right wall plays back
whatever reaches the sensors; placeable optical elements in between reshape
the audio's pitch mapping, timbre, and spatial routing. Under the audio
framing is a real 2D optics simulation. Plain HTML + ES modules + WebGL2.
No dependencies.

## Module layout

- `docs/index.html`, `docs/style.css` — two-row / three-column grid
  shell with a fixed-height top toolbar; side panels slide in as
  drawers on the mobile breakpoint (see the `@media` rule in
  `docs/style.css` for the cutoff).
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, `MATERIALS` table.
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer; per-frame segment records + sensor bins.
- `docs/renderer.js` — WebGL2, three passes: (1) instanced SDF quad rays
  rendered into an FBO (additive blend, soft falloff), (2) FBO blit to
  screen plus per-element bounding-quad pass that re-samples the FBO with
  a polygon-SDF-driven offset for refractive distortion and material
  tinting, (3) alpha-blended overlay lines for the bench outline, element
  outlines, emitter/sensor ticks, and an inline per-sensor mini-spectrum
  painted next to each sensor tick so the wavelength distribution is
  always visible on the canvas even when the right panel is scrolled or
  short.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel,
  save/load, preset dropdown, undo/redo, keyboard shortcuts.
- `docs/mic.js` — audio input (mic or synthetic source) + FFT bucket extraction.
- `docs/synth.js` — additive sensor synth (harmonic partials driven by bins).
- `docs/main.js` — wiring + dirty-flag render loop + device pickers.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`,
`bench.h`. The renderer re-derives bench size from canvas aspect on
resize; the fixed short-axis value is in `Renderer.benchSize`. All UI
input is converted via `UI.canvasToBench`.

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

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). The static server's ROOT is
`docs/`, which is also the folder GitHub Pages serves.
