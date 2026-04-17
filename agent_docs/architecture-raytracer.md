# Architecture: Ray Tracer

`docs/raytracer.js` produces per-frame segment records for the WebGL2
renderer and updates per-sensor spectrum bins. Segments are 12-float
entries (`[p1x, p1y, p2x, p2y, c1rgb*I1, I1, c2rgb*I2, I2]`) expanded
by the renderer into instanced SDF quads with per-fragment soft
falloff.

Two stages run per `trace()`:

1. **Particle advance** — for each delay element (a dielectric with
   `delayK > 0`) the tracer walks its `ParticlePool`, advances each
   record by `speed * dt * simRate`, decays intensity by Beer-Lambert,
   and emits a short trail segment. Particles that step across a local
   polygon edge are clipped to the crossing, refracted out using Snell
   against the outside medium, and queued as secondary emissions.
2. **Primary + secondary ray pass** — wall-emitter rays, plus every
   secondary emission from stage 1, are traced by `castRay`. When a
   primary ray hits the boundary of a delay element from outside, the
   tracer **captures** it (stores an element-local record in the
   pool) instead of refracting through. The ray never traverses the
   glass in a single frame; its transit is distributed across however
   many frames `delayK × path` seconds take.

This is a stateful simulation: pools persist between `trace()` calls,
so light held inside a slow-glass continues propagating even after
the mic input that emitted it has stopped. Moving or rotating the
element carries the held wavefront with it — particles are stored in
the element's *local* frame.

## Notes

- Max bounces, per-surface glass loss, and absorption cutoff are module
  constants at the top of `docs/raytracer.js` (`MAX_BOUNCES`,
  `GLASS_LOSS`, `BASE_INTENSITY`). Prefer reading those instead of
  quoting numbers.
- Particle floor: `PARTICLE_EPS`. Records below this intensity are
  culled on the advance pass.
- Per-ray intensity scales sub-linearly with `raysPerSource` so piling
  on rays brightens rather than dims.
- Source modelling: each source is an extended aperture across a
  fraction of its y-strip (`emitter.apertureFactor`). Ray origins,
  wavelengths, and angles use decorrelated golden-ratio sequences so
  the beam looks continuous.
- Wavelength assignment: every source emits the same wavelength mix
  across `emitter.wlMin..wlMax`. With `emitter.wlPerSource` set
  (Bucket color), sources get their own narrow wavelength band.
- Disabled sources: `emitter.disabled` is a `Set<number>` of source
  indices to skip entirely. Toggled by clicking the left-wall tick;
  shift-click or long-press solos.
- Per-source mic gain: if `emitter.micLevels` is present, each
  primary-emission intensity is scaled by `micLevels[s]`.
- No Fresnel amplitude split. Full transmission unless TIR.
- Beer-Lambert absorption: while a primary ray is inside a non-delay
  dielectric, each segment is attenuated by `exp(-α(λ) · d)` where α
  comes from `elementAbsorption(el, mat, λ)`. When `el.color` is set,
  α is derived from the color as a transmission filter.
- Dichroic mirrors: reflectance from `elementReflectance(el, mat, λ)`;
  non-reflected fraction is absorbed, not transmitted.
- Sensor deposits: a sensor hit adds `I` to
  `sensorBins[sIdx * binCount + binIdx]`. Sensor timing is implicit —
  photons that traversed a delay glass arrive at the sensor on the
  frame they exit, so the deposit pattern already reflects the
  delay without any separate gating.
- Starting medium: at primary-ray birth every non-delay dielectric
  polygon is tested and containing polygons pushed onto the
  inside-stack. Delay elements are *excluded* because primary rays
  can't be "inside" one — they're captured before reaching the
  interior.
- Nested / overlapping non-delay dielectrics: `this._stack` holds the
  elements the ray is currently inside, last-entered on top.
- Particle attachment: each particle belongs to exactly one element,
  the one it entered. Overlapping another delay element mid-flight
  does not re-attach. Deleting the element drops its pool entirely;
  in-flight light vanishes.

## Dispersion gotchas (important)

- Sellmeier `n²(λ) = 1 + Σ Bᵢ λ²/(λ²−Cᵢ)` with λ in µm for real
  materials; Cauchy `n = A + B/λ²` for synthetic. Coefficients live
  in `MATERIALS` in `docs/spectrum.js`.
- **Equilateral-prism TIR constraint**: for a ray to pass through a
  60° prism, `n < 2` is required. `diamond` exceeds 2 and always
  TIRs; `hyper` is tuned below 2.
- **Prism orientation matters**: with `rot=0` (apex up) and
  horizontal rays, incidence is only 30° — near the TIR cutoff for
  flint. Default `rot` for prisms is set in `makeElement`.
- **Block zig-zag**: rectangular dielectrics always TIR on faces
  *adjacent* to the entry face. Rays can only exit through the
  parallel opposite face, zigzagging off perpendicular walls. Long
  zigzags hit `MAX_BOUNCES` and leave a stub inside the glass.

## Delay / particle specifics

- Each `ParticlePool` stores records as a flat `Float32Array`, 8
  floats per particle: `[lx, ly, ldx, ldy, I, wl, lastLx, lastLy]`.
  Compact-on-remove via swap-with-last.
- At entry capture, the tracer refracts the primary ray through the
  boundary once to get the inward world direction, then transforms
  entry point and direction into element-local coordinates using
  `el.rot` and `el.x`/`el.y`. `lastLx/Ly` is seeded to the entry
  point so the first trail segment spans entry → first-step.
- Advance step: `lx += ldx * (1 / delayK) * dt * simRate` (same for
  `ly`). Effective speed is `1 / delayK` bench units per second at
  1×; sim-rate scales directly.
- Exit: `segSegT` finds the nearest polygon edge that the advance
  step crossed; position is clipped to the crossing; outward world
  normal is derived from the local edge + element's rotation. The
  outside medium is found by testing other dielectric polygons at
  the exit world point (so nested delay-in-dielectric composes).
  Snell refracts to produce the exit direction; TIR keeps the
  particle in the pool with a reflected local direction.
- Trail segments: one per particle per advance step, drawn in world
  coordinates from the previous `(lastLx, lastLy)` to the new
  `(lx, ly)`, colored `wavelengthToRGB(wl) × I`. Same shader as
  primary ribbons — no new draw pass.
- The tracer caches a local-polygon copy per element id keyed on
  `_localPolys`. Because particles are in local coords, moving or
  rotating the element doesn't invalidate held particles — only the
  world-space transform applied at trail-emission and exit changes.

## Performance notes

Hot-loop allocations are avoided:

- Bench walls live on the Tracer (`this._walls`); their coordinates
  are written once per `trace()`.
- The inside-medium `stack` is a reusable Tracer field.
- The initial-medium scan iterates `this._elementInfos` by index.
- `n1`/`n2` lookups inline the Sellmeier/Cauchy dispatch.
- Particle pools are flat `Float32Array`s; no per-particle object
  allocation.

Per-frame costs scale roughly as:

- Primary rays: `nSrc × raysPerSource × MAX_BOUNCES` edge tests.
- Particle advance: `totalParticleCount × localPolyEdges` edge tests
  for exit detection. At 6k rays entering a 0.5 s slow-glass the
  steady-state population is ~180k; containment test dominates.
- Trail segments: one per particle per frame; segment upload bandwidth
  stays small because the segment stride is only 12 floats.
