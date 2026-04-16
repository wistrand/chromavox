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

Any dielectric can carry an optional `delayK` field — seconds per bench
unit of internal path. The tracer maintains two parallel time
accumulators inside the ray hot loop (see
`architecture-raytracer.md`):

- `rayTimeAudio` — advances **only while inside** a `delayK`
  material. Clamped to `MAX_DELAY = 2 s` to match the
  `DelayNode.maxDelayTime` ceiling on the synth side. The synth reads
  the amplitude-weighted per-sensor mean as `tracer.sensorDelay[s]`
  and drives a per-voice `DelayNode`.
- `rayTimeVisual` — advances across every segment at `propK = max(
  delayK, VACUUM_PROP_K )`. With the default `VACUUM_PROP_K = 0`,
  vacuum is lightspeed: segments outside delay glass emit with
  `tStart == tEnd == 0` and render instantly; only segments inside a
  `delayK` material crawl. Per-segment `tStart`/`tEnd` drive the
  fragment shader's chase animation.

The shipped material `slowGlass` is a crown-glass-shaped dielectric
with `delayK = 0.002` (2 ms per bench unit). Composes naturally with
refraction + absorption; nothing else in the tracer or renderer needs
to know it's "special". A per-element `el.delayK` slider in the
property panel lets any dielectric carry its own delay override — the
fingerprint logic in `ui.js` picks up that field too.
