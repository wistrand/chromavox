# Architecture: Overview

Optical synthesizer in the browser. Audio input modulates a row of light
emitters on the left wall; an additive synth on the right wall plays back
whatever reaches the sensors; placeable optical elements in between reshape
the audio's pitch mapping, timbre, and spatial routing. Under the audio
framing is a real 2D optics simulation. Plain HTML + ES modules + WebGL2.
No dependencies.

## Module layout

- `docs/index.html`, `docs/style.css` — 3-column shell; drawer panels on ≤860px.
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, `MATERIALS` table.
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer + sensor bins.
- `docs/renderer.js` — WebGL2. Two passes: additive line blend (light field),
  alpha overlay for element outlines and emitter/sensor ticks.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel,
  save/load, preset dropdown, undo/redo, keyboard shortcuts.
- `docs/mic.js` — audio input (mic or synthetic source) + FFT bucket extraction.
- `docs/synth.js` — additive sensor synth (harmonic partials driven by bins).
- `docs/main.js` — wiring + dirty-flag render loop + device pickers.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`,
`bench.h`. The renderer re-derives bench size from canvas aspect on resize
(fixed short axis = 900). All UI input is converted via `UI.canvasToBench`.

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
