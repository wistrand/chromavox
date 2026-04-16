# Architecture: Materials

Defined in `docs/spectrum.js`. Each entry in `MATERIALS` has
`type: 'dielectric' | 'mirror'`, dispersion data (Sellmeier 3-term for
real glasses; Cauchy `A, B` for synthetic ones), and one of `absorb`
(dielectrics) or `reflect` (mirrors). Both are Gaussian-band parametric:
`{ base, peak, center, sigma }`.

## Dielectrics

- `crown` (N-BK7, essentially clear)
- `flint` (N-SF11, rose-tinted — absorbs blue/violet)
- `fused` (fused silica, clear)
- `water` (cyan-tinted — absorbs red)
- `diamond` (real n≈2.4; will TIR through a 60° prism)
- `hyper` (synthetic, ~4× flint dispersion, magenta-tinted, safely n<2)

## Mirrors

- `mirror` (neutral silver, R≈0.98 flat)
- `mirror-red` / `mirror-green` / `mirror-blue` (dichroic — narrow band
  reflectance, rest absorbed)

## Helper functions

- `materialN(mat, λ)` — returns refractive index. Dispatches Sellmeier
  vs Cauchy based on which fields the material carries.
- `materialAbsorption(mat, λ)` — returns α in 1/bench-unit. Path lengths
  are hundreds of units, so peak ~0.004 gives a noticeable gradient over
  ~200 units.
- `mirrorReflectance(mat, λ)` — returns R in [0, 1].

## UI integration

The material `<select>` in the property panel filters `MATERIALS` by
`type` — dielectric elements see only dielectrics, mirror elements see
only mirror variants.

## Scale notes

- α values are per bench unit, not per metre. Adjust in absolute bench
  coordinates when tuning.
- `R(λ)` base and peak clamp to `[0, 1]`; sum of the two can exceed 1
  before clamping.
- Cauchy is a truncation of Sellmeier and is accurate enough across the
  visible range; reserve it for synthetic materials where exact
  coefficients aren't available.
