# Architecture: Ray Tracer

`docs/raytracer.js` produces per-frame line segment vertex data for the
WebGL2 renderer and updates per-sensor spectrum bins.

## Notes

- Max bounces: `MAX_BOUNCES = 12`.
- Per-ray intensity: `1.6 / sqrt(raysPerSource)` — sub-linear so piling on
  rays brightens the field instead of dimming to nothing.
- Source modelling: each source is an extended aperture across a fraction
  of its y-strip (`emitter.apertureFactor`, slider 0–1, default 0.01).
  Ray origins, wavelengths, and angles use decorrelated golden-ratio
  sequences so the beam looks continuous rather than an ordered fan.
- Wavelength assignment: every source emits the same `raysPer`-wide mix
  from `wlMin..wlMax`. Same mix per source by design. With
  `emitter.wlPerSource` set (audio in + "Bucket color" option) sources get
  their own narrow wavelength band instead.
- Disabled sources: `emitter.disabled` is a `Set<number>` of source indices
  to skip entirely. Toggled by clicking the left-wall tick; shift-click
  solos.
- Per-source mic gain: if `emitter.micLevels` is present, each source's
  ray intensity is scaled by `micLevels[s]` (that source's audio bucket
  amplitude).
- No Fresnel amplitude split. 100% transmission unless TIR. Simpler and
  fine for pedagogy; adding reflected rays at each dielectric surface
  would branch the ray tree and change the buffer sizing.
- Beer-Lambert absorption: while a ray is inside a dielectric, each
  segment is attenuated by `exp(-α(λ) · d)` where α comes from the
  material's absorption band. Segment endpoints carry different
  intensities; the GL line interpolates so a long internal path fades
  along its length.
- Dichroic mirrors: mirror materials expose a wavelength-dependent
  reflectance `R(λ)` instead of a flat 0.98. The non-reflected fraction
  is absorbed, not transmitted — keeps the ray tree unbranched.
- Ray absorbed at bench walls; sensor wall is the right edge, deposits
  into a `sensorCount × 64` histogram by (y-strip, wavelength-bin).
- Starting medium: `pointInPolygon` test at emitter origin decides if the
  ray starts inside a dielectric. Matters if a lens is dropped over the
  emitter line.

## Dispersion gotchas (important)

- Sellmeier `n²(λ) = 1 + Σ B_i λ²/(λ²−C_i)` with λ in µm (Cauchy for
  synthetic).
- **Equilateral-prism TIR constraint**: for any ray to pass through a
  60° prism, `n < 2` is required — otherwise the internal ray hits the
  exit face beyond the critical angle and total-internally-reflects.
  `diamond` (n≈2.4) always TIRs; `hyper` is tuned below 2.
- **Prism orientation matters**: with `rot=0` (apex up) and horizontal
  rays, incidence is only 30° — near the TIR cutoff for flint. Default
  `makeElement` gives prisms `rot=π/6` so new placements disperse
  visibly.
- **Block zig-zag**: rectangular dielectrics always TIR on faces
  *adjacent* to the entry face (geometry: adjacent-face incidence ≥
  90°−θc > θc). Rays can only exit through the parallel opposite face,
  zigzagging off perpendicular walls. Long zigzags hit `MAX_BOUNCES`
  and leave a stub inside the glass.
