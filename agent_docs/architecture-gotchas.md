# Architecture: Known Gotchas

## Rendering

- `gl.lineWidth` is driver-clamped to 1px on nearly all WebGL
  implementations. Rays avoid this by rendering as instanced SDF quads
  (`docs/renderer.js`). Overlay elements (bench outline, emitter/sensor
  ticks, element polygons) still use line primitives; emitter ticks
  stack three 1px lines vertically to look thicker.
- Additive blending is not physically accurate for monochromatic beams
  piling up — overlap saturates to white regardless of wavelength. This
  is a long-standing trade-off discussed in the render design; a true
  fix would require an HDR framebuffer and tone-mapping pass.

## Physics

- `hyper` and `diamond` materials illustrate the `n < 2` TIR constraint
  on a 60° prism — don't mistake internal bouncing for a physics bug.
  See `architecture-raytracer.md`.
- Block zigzag is also real physics: adjacent faces of a rectangular
  dielectric always TIR, so rays can only exit through the parallel
  opposite face.

## Audio

- Chromatic mode range equals `count × stepSemi` semitones. At default
  `stepSemi=1` and 12 sources, only one octave is covered — bump count
  or widen Span to see more of the input spectrum.
- `AudioContext.setSinkId()` is not supported in older browsers; the
  app silently falls back to the system-default audio output.
- Mic stream: we request `echoCancellation=false, autoGainControl=false,
  noiseSuppression=false`. On Linux/PipeWire some drivers still apply
  processing out of our control; verify with OS tools like
  `pavucontrol`.

## UI / state

- Slider sanity: nothing prevents `wlMin > wlMax`; the tracer handles
  it but the output gets weird.
- Large ray counts (128 sources × 2000 rays/source = 256k rays) are the
  hard cap via slider maxes. The vertex buffer can balloon; watch for
  perf drops on low-end mobile.
- The element material dropdown filters by element kind
  (dielectric/mirror); switching a mirror's material to a dielectric
  value is not possible from the UI — change via JSON edit if needed.
