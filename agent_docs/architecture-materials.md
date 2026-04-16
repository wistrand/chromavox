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
