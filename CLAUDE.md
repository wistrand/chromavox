# Chromavox

2D optics raycaster: emitters on the left, sensors on the right, placeable
dielectric/mirror elements in between. Real Snell refraction with Cauchy
wavelength-dependent index. Plain HTML + ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`).

## Layout

- `docs/index.html`, `docs/style.css` — 3-column shell; drawer panels on ≤860px.
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Cauchy `n(λ)=A+B/λ²`, glass presets.
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer + sensor bins.
- `docs/renderer.js` — WebGL2. Two passes: additive line blend (light field), alpha overlay.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel, save/load.
- `docs/main.js` — wiring + dirty-flag render loop.
- `serve.js` — zero-dep static server.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`, `bench.h`.
The renderer re-derives bench size from canvas aspect on resize (fixed short axis = 900).
All UI input is converted via `UI.canvasToBench`.

Y is **down** (screen convention). Polygon winding and outward-normal sign in
`worldEdges` depend on this — see the shoelace / `cw` logic. If you change the
coordinate convention, re-derive the normal sign carefully; getting it wrong
flips refraction direction and everything breaks subtly.

## Render loop

`main.js` uses a dirty flag. `markDirty()` is passed to `UI` as `onChange` and
called on every interaction. Don't run the tracer on every RAF unconditionally —
it's pure JS and expensive at high ray counts.

## Ray tracer notes

- Max bounces: 12 (in `raytracer.js`).
- Per-ray intensity: `1.6 / sqrt(raysPerSource)` — sub-linear so piling on rays
  brightens the field instead of dimming to nothing.
- No Fresnel amplitude split. 100% transmission unless TIR. Simpler and fine for
  pedagogy; adding reflected rays at each dielectric surface would branch the
  ray tree and change the buffer sizing.
- Ray absorbed at bench walls (user requirement); sensor wall is the right edge,
  deposits into a `sensorCount × 64` histogram by (y-strip, wavelength-bin).
- Starting medium: `pointInPolygon` test at emitter origin decides if the ray
  starts inside a dielectric. Matters if user drops a lens over the emitter line.

## Geometry

Elements are convex polygons. Lens surfaces are arc-approximations (24 verts per
arc for convex, 20 for concave). Lens params are constrained:
- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

If you add a new element kind, extend `localPolygon`, `makeElement`, UI's
`sizeFields`, and `elementColor` in the renderer.

## Save/load

JSON is `version: 1`. `_selected` flag is stripped on serialize. `deserializeScene`
regenerates ids so loaded scenes don't collide with existing ones. Bench size is
stored but gets clobbered by the next resize — positions are in logical units,
so the scene still renders, just possibly out of view if the source bench aspect
was very different.

## Mobile

- `touch-action: none` on canvas; pointer events unified.
- Hamburger button toggles left/right drawers, cycles L → R → closed.
- DPR capped at 2 in renderer for perf.

## Known gotchas

- `gl.lineWidth` is driver-clamped to 1px on nearly all WebGL implementations.
  Thick glowing rays would require rendering quads instead of lines.
- Slider sanity: nothing prevents `wlMin > wlMax`; tracer handles it but the
  output gets weird.
- Large ray counts (128 sources × 256 rays = 32k rays) are the hard cap via
  slider maxes. Product can balloon vertex buffer memory; watch for perf drops
  on low-end mobile.
