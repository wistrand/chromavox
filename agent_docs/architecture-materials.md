# Architecture: Materials

Defined in `docs/spectrum.js`. Each entry in `MATERIALS` has
`type: 'dielectric' | 'mirror'`, dispersion data (Sellmeier coefficients
for real glasses; Cauchy `A, B` for synthetic ones), and one of
`absorb` (dielectrics) or `reflect` (mirrors). Both are Gaussian-band
parametric: `{ base, peak, center, sigma }`.

Refer to the `MATERIALS` object in `docs/spectrum.js` for the
authoritative list of materials and their current tuning — the set
changes over time.

## Helper functions

- `materialN(mat, λ)` — refractive index. Dispatches Sellmeier vs
  Cauchy based on which fields the material carries.
- `materialAbsorption(mat, λ)` — α in 1/bench-unit from the material's
  absorption band.
- `materialDelay(mat)` — seconds of audio delay per bench unit of
  interior path. Returns 0 if the material has no `delayK` field.
- `mirrorReflectance(mat, λ)` — R in [0, 1] from the material's
  reflectance band.
- `elementAbsorption(el, mat, λ)` — α with `el.color` override: if set,
  derives α from the color as a transmission filter; otherwise falls
  back to `materialAbsorption(mat, λ)`.
- `elementReflectance(el, mat, λ)` — same override logic for mirror
  reflectance.
- `hexToRgb(hex)` — shared color parser used by both UI and renderer.

The transmission-filter model's reference path length and the mirror
reflectance mapping constants live at the top of `docs/spectrum.js`.

## UI integration

The property panel's material `<select>` filters `MATERIALS` by `type`
so dielectric elements see only dielectrics and mirror elements see
only mirror variants. The color override (picker + hue slider) is
independent of the material choice and, when set, reshapes both
absorption (glass) or reflectance (mirrors).

## Scale notes

- α values are per bench unit, not per metre. Tune in the `absorb`
  entry of the material.
- `R(λ)` clamps to `[0, 1]` in `mirrorReflectance`.
- Cauchy is a truncation of Sellmeier and is accurate enough across the
  visible range; reserve it for synthetic materials where exact
  coefficients aren't available.

## Delay materials

Any dielectric can carry an optional `delayK` field — seconds per
bench unit of local path. Under Phase 3 this is the parameter that
governs a genuine time-stepped simulation, not an animation rate:

- **Primary rays that enter a `delayK` element are captured**, not
  refracted through. `castRay` records a photon particle in the
  element's local-coordinate `ParticlePool` (position + inward
  direction + current intensity + wavelength) and terminates that
  primary path. The interior of the glass is never drawn by the
  primary tracer.
- **Each frame the tracer advances every pool** by
  `step = (1 / delayK) * dt * simRate`, emits one short trail
  segment in world coords (drawn by the normal ray shader), and
  decays intensity by Beer-Lambert over `step`.
- **Particles exit** when an advance step crosses a local polygon
  edge. The tracer clips to the crossing, refracts out through the
  boundary (Snell against the outside medium at the exit world
  point), and queues the secondary ray for the same frame's
  `castRay` pipeline. Sensor deposits happen when the secondary ray
  reaches the sensor wall — so a photon that spent 0.4 s inside the
  glass deposits on the sensor 0.4 s of wall-clock time after it
  entered.

Nothing else in the tracer or renderer needs to know a material is
"delay". The shipped material `slowGlass` is a crown-glass-shaped
dielectric with `delayK = 0.002` (2 ms per bench unit); a per-element
`el.delayK` slider in the property panel lets any dielectric carry a
delay override. TIR at entry (sharp grazing angle hitting a
high-index delay material) keeps the primary ray in the normal
reflection path — the particle is only created after a successful
refractive crossing.
