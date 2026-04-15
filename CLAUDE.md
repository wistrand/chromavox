# Chromavox

2D optics raycaster: emitters on the left, sensors on the right, placeable
dielectric/mirror/silhouette elements in between. Real Snell refraction with
Cauchy wavelength-dependent index. Optional microphone modulation. Plain HTML
+ ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). The static server's ROOT is `docs/`,
which is also the folder GitHub Pages serves.

## Layout

- `docs/index.html`, `docs/style.css` — 3-column shell; drawer panels on ≤860px.
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Cauchy `n(λ)=A+B/λ²`, material presets.
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer + sensor bins.
- `docs/renderer.js` — WebGL2. Two passes: additive line blend (light field), alpha overlay.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel, save/load, preset dropdown.
- `docs/mic.js` — microphone capture + log-spaced FFT buckets.
- `docs/main.js` — wiring + dirty-flag render loop.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`.

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
it's pure JS and expensive at high ray counts. When the microphone is active
the loop marks dirty each frame so audio buckets animate.

## Ray tracer notes

- Max bounces: 12 (in `raytracer.js`).
- Per-ray intensity: `1.6 / sqrt(raysPerSource)` — sub-linear so piling on rays
  brightens the field instead of dimming to nothing.
- Source modelling: each source is an extended aperture across a fraction of
  its y-strip (`emitter.apertureFactor`, slider 0–1, default 0.01). Ray origins,
  wavelengths, and angles use decorrelated golden-ratio sequences so the beam
  looks continuous rather than an ordered fan.
- Wavelength assignment: every source emits the same `raysPer`-wide mix from
  `wlMin..wlMax`. Same mix per source by design.
- Per-source mic gain: if `emitter.micLevels` is present, each source's ray
  intensity is scaled by `micLevels[s]` (that source's audio bucket amplitude).
- No Fresnel amplitude split. 100% transmission unless TIR. Simpler and fine for
  pedagogy; adding reflected rays at each dielectric surface would branch the
  ray tree and change the buffer sizing.
- Ray absorbed at bench walls; sensor wall is the right edge, deposits into a
  `sensorCount × 64` histogram by (y-strip, wavelength-bin).
- Starting medium: `pointInPolygon` test at emitter origin decides if the ray
  starts inside a dielectric. Matters if user drops a lens over the emitter line.

## Dispersion gotchas (important)

- Cauchy `n(λ) = A + B/λ²` with λ in µm. Materials: `crown`, `flint`, `fused`,
  `water`, `diamond` (real, n>2), `hyper` (synthetic demo, ~4× flint dispersion).
- **Equilateral-prism TIR constraint**: for any ray to pass through a 60° prism,
  `n < 2` is required — otherwise the internal ray hits the exit face beyond the
  critical angle and total-internally-reflects. `diamond` (n≈2.4) always TIRs;
  `hyper` is tuned below 2.
- **Prism orientation matters**: with `rot=0` (apex up) and horizontal rays,
  incidence is only 30° — near the TIR cutoff for flint. Default `makeElement`
  gives prisms `rot=π/6` so new placements disperse visibly.
- **Block zig-zag**: rectangular dielectrics always TIR on faces *adjacent* to
  the entry face (geometry: adjacent-face incidence ≥ 90°−θc > θc). Rays can
  only exit through the parallel opposite face, zigzagging off perpendicular
  walls. Long zigzags hit `MAX_BOUNCES` and leave a stub inside the glass.

## Elements

Convex polygons are easy; non-convex also works (e.g. `rabbit`) as long as
winding is consistent (CW in y-down). Lens surfaces are arc-approximations
(24 verts per arc for convex, 20 for concave).

Lens params are constrained:
- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

Default rotations are chosen so horizontal rays produce a visible effect on
placement:
- `prism` — π/6 (~30°): avoids flint TIR.
- `block` — π/6: axis-aligned block has 0° incidence → passes through invisibly.
- `mirror` — π/4 (45°): axis-aligned thin strip would be grazed by rays.
- `rabbit`, lenses — 0: on-axis is correct.

If you add a new element kind, extend `localPolygon`, `makeElement`, UI's
`sizeFields`, and `elementColor` in the renderer, and add a tool button in
`index.html`.

## Microphone modulation

Toggle button in the Emitters section requests mic access. When active:
- `mic.sample()` runs each frame.
- `micBands(mic, emitter.count)` downsamples the FFT into `emitter.count`
  log-spaced buckets (80–6000 Hz), with a noise-floor subtraction (0.22) and
  γ=1.5, so quiet buckets are truly zero.
- The per-bucket amplitudes are written to `scene.emitter.micLevels`.
- Renderer draws an amber bar extending from each emitter tick proportional to
  its bucket level.
- Tracer uses each bucket value as a gain on that source's rays: silent
  buckets → dark, loud buckets → bright.

Wavelength and ray count are not touched by the mic.

## Save/load

JSON is `version: 1`. `_selected` flag is stripped on serialize. `deserializeScene`
regenerates ids so loaded scenes don't collide with existing ones. On load, a
synthetic `resize` event is dispatched so `scene.bench` snaps to the current
canvas aspect — otherwise a 1600×900 preset loaded into a different-aspect
viewport would stretch polygons (visible as a non-equilateral prism).

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI fetches it on
startup and populates the Scene panel's Preset dropdown. Preset files are
identical in shape to saved scenes.

## Mobile

- `touch-action: none` on canvas; pointer events unified.
- Hamburger button toggles left/right drawers, cycles L → R → closed.
- DPR capped at 2 in renderer for perf.

## UI interaction

- Tool palette: click to select tool, then click on canvas to place element.
- Select tool: click to pick an element; drag to move.
- **Shift-drag** or **right-button drag** on a selected element to rotate
  around its center.
- Property panel shows rotation (live slider), material, size fields, delete.

## Known gotchas

- `gl.lineWidth` is driver-clamped to 1px on nearly all WebGL implementations.
  Thick glowing rays would require rendering quads instead of lines.
- Slider sanity: nothing prevents `wlMin > wlMax`; tracer handles it but the
  output gets weird.
- Large ray counts (128 sources × 2000 rays/source = 256k rays) are the hard
  cap via slider maxes. Product can balloon vertex buffer memory; watch for
  perf drops on low-end mobile.
- `hyper` and `diamond` materials illustrate the `n < 2` TIR constraint —
  don't mistake internal bouncing for a physics bug.
