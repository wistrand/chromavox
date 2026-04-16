# Architecture: Ray Tracer

`docs/raytracer.js` produces per-frame segment records for the WebGL2
renderer and updates per-sensor spectrum bins. Each segment is a single
14-float entry (`[p1x, p1y, p2x, p2y, c1rgb*I1, I1, c2rgb*I2, I2,
tStart, tEnd]`) that the renderer expands into an instanced SDF quad
with per-fragment soft falloff. The trailing `tStart`/`tEnd` pair drives
the Phase 2 chase animation (rays only render once the visual clock
crosses each fragment's interpolated arrival time).

## Notes

- Max bounces, per-surface glass loss, and absorption cutoff are module
  constants at the top of `docs/raytracer.js` (`MAX_BOUNCES`,
  `GLASS_LOSS`, `BASE_INTENSITY`). Prefer reading those instead of
  quoting numbers.
- Per-ray intensity scales sub-linearly with `raysPerSource` so piling
  on rays brightens rather than dims — see the `intensity =` expression
  in `trace()`.
- Source modelling: each source is an extended aperture across a
  fraction of its y-strip (`emitter.apertureFactor`; UI slider in the
  left panel). Ray origins, wavelengths, and angles use decorrelated
  golden-ratio sequences so the beam looks continuous.
- Wavelength assignment: every source emits the same wavelength mix
  across `emitter.wlMin..wlMax`. Same mix per source by design. With
  `emitter.wlPerSource` set (audio in + "Bucket color") sources get
  their own narrow wavelength band instead.
- Disabled sources: `emitter.disabled` is a `Set<number>` of source
  indices to skip entirely. Toggled by clicking the left-wall tick;
  shift-click or long-press solos.
- Per-source mic gain: if `emitter.micLevels` is present, each source's
  ray intensity is scaled by `micLevels[s]` (that source's audio bucket
  amplitude).
- No Fresnel amplitude split. Full transmission unless TIR. Adding
  reflected rays at each dielectric surface would branch the ray tree
  and change the buffer sizing.
- Beer-Lambert absorption: while a ray is inside a dielectric, each
  segment is attenuated by `exp(-α(λ) · d)` where α comes from
  `elementAbsorption(el, mat, λ)` in `docs/spectrum.js`. When
  `el.color` is set, α is derived from the color as a transmission
  filter; otherwise from the material's absorption band. Segment
  endpoints carry different intensities; the GL line interpolates so a
  long internal path fades along its length.
- Audio delay: while a ray is inside a material with a `delayK` field
  (seconds per bench unit), `rayTimeAudio += delayK · d` accumulates in
  the same Beer-Lambert block. Capped at `MAX_DELAY = 2 s`. The synth
  reads the per-sensor amplitude-weighted mean (computed in
  `rebuildSensorsGated`) as `tracer.sensorDelay[s]` and drives per-voice
  `DelayNode`s.
- Visual chase: a parallel accumulator `rayTimeVisual += propK · d`
  tracks where the wavefront has reached. `propK` is `delayK` inside a
  delay material, otherwise `VACUUM_PROP_K` (default `0` — lightspeed
  outside delay glass). Per-segment `tStart`/`tEnd` are written into the
  segment record so the renderer can `discard` fragments not yet
  reached. With the default, scenes without a delay element emit
  segments with `tStart == tEnd == 0`, keeping `tracer.maxT = 0` and
  drawing instantly — the chase only ever visibly animates where a
  ray threads a `delayK` material.
- Sensor deposits: castRay does **not** populate `sensorBins` directly;
  it appends one row to `sensorEvents` (5 floats: `[sIdx, binIdx, I,
  rayTimeVisual, rayTimeAudio]`). Each frame `main.js` calls
  `tracer.rebuildSensorsGated(uTphysical)` which walks the event log
  and re-populates `sensorBins`/`sensorDelay`/`sensorWeight`, skipping
  events with `rayTimeVisual > uTphysical` so the synth-facing
  histogram fills in over the chase. `tracer.totalEnergy` caches the
  un-gated aggregate energy for the mic onset detector.
- `tracer.maxT` is updated from **every** `emitSeg(tEnd)`, not only on
  sensor hits — otherwise rays that get absorbed at a non-sensor wall
  (top/bottom/left bench edges, or ones that exceed `MAX_BOUNCES`)
  would have segments with `tEnd > 0` but a `maxT` stuck at 0, and the
  renderer's `discard` would eat them. When there's no delay material
  in the scene, every `tEnd` is 0 and `maxT == 0` — `main.js` detects
  that and bypasses the leading-edge fade entirely.
- Dichroic mirrors: mirror reflectance comes from
  `elementReflectance(el, mat, λ)`. With `el.color`, reflectance
  follows the colored filter; otherwise the material's dichroic band.
  Non-reflected fraction is absorbed, not transmitted — keeps the ray
  tree unbranched.
- Ray absorbed at bench walls; sensor wall is the right edge, deposits
  into a `sensorCount × binCount` histogram by (y-strip,
  wavelength-bin). `binCount` is a `Tracer` instance field.
- Starting medium: at ray birth every dielectric polygon is tested
  (`pointInPolygon`) and containing polygons are pushed onto an
  inside-stack. Matters if a lens is dropped over the emitter line and
  also when elements nest/overlap.
- Nested / overlapping dielectrics: `this._stack` holds the dielectric
  elements the ray is currently inside, last-entered on top. The
  top-of-stack supplies Beer-Lambert α and is the incident/exit medium
  for Snell. Entering pushes, exiting pops; TIR rolls the pop back so a
  ray that internally reflects stays in the correct medium.

## Dispersion gotchas (important)

- Sellmeier `n²(λ) = 1 + Σ Bᵢ λ²/(λ²−Cᵢ)` with λ in µm for real
  materials; Cauchy `n = A + B/λ²` for synthetic. Coefficients live in
  `MATERIALS` in `docs/spectrum.js`.
- **Equilateral-prism TIR constraint**: for a ray to pass through a
  60° prism, `n < 2` is required. `diamond` exceeds 2 and always TIRs;
  `hyper` is tuned below 2. Check the `MATERIALS` entries to see which
  materials satisfy this.
- **Prism orientation matters**: with `rot=0` (apex up) and horizontal
  rays, incidence is only 30° — near the TIR cutoff for flint. Default
  `rot` for prisms is set in `makeElement` (`docs/scene.js`).
- **Block zig-zag**: rectangular dielectrics always TIR on faces
  *adjacent* to the entry face (geometry: adjacent-face incidence ≥
  90°−θc > θc). Rays can only exit through the parallel opposite
  face, zigzagging off perpendicular walls. Long zigzags hit
  `MAX_BOUNCES` and leave a stub inside the glass.

## Performance notes

Hot-loop allocations are avoided:

- Bench walls live on the Tracer (`this._walls`) and their coordinates
  are written once per `trace()`.
- The inside-medium `stack` is a reusable Tracer field; `stack.length =
  0` at the start of each ray.
- The initial-medium scan iterates `this._elementInfos` by index — no
  Map iterator allocation.
- `n1`/`n2` lookups inline the Sellmeier/Cauchy dispatch.

Remaining per-frame allocations are outside the ray hot loop: `edges`
array, `elementMap`, `worldEdges()` polygon/edge objects (per element,
rebuilt each frame), and one `wavelengthToRGB` result per ray.
