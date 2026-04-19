# Architecture: GPU Tracer

## Overview

`docs/gpu-tracer.js` is a WebGL2 transform-feedback alternative to the
CPU tracer (`docs/raytracer.js`). Default when no delay elements are
present; `main.js` auto-switches to the CPU tracer when delay elements
are added (`pickTracer()` in the frame loop). The left panel shows
"Tracer: GPU" or "Tracer: CPU". Force CPU with `?cpu` URL param.

## Transform feedback pipeline

Each input vertex represents a `(ray, bounce)` pair. The vertex shader
traces the full ray path from the emitter up to that bounce index and
outputs the segment at that bounce. Degenerate segments (zero
intensity) are emitted for bounces past the ray's termination — they
render as invisible (zero alpha with additive blending).

- **Input buffer**: `totalRays × MAX_BOUNCES` vertices, each carrying
  `(rayIndex, bounceIndex)` as two floats. `STATIC_DRAW`, rebuilt only
  when ray count changes.
- **TF buffer**: 16 floats per vertex (`v_p[4] + v_c1[4] + v_c2[4] +
  v_meta[4]`). The renderer binds this buffer directly as vertex data
  (zero-copy — no CPU→GPU segment upload).
- **Scene data**: element edges + material properties packed as RGBA32F
  textures (allocated once at max size via `texStorage2D`, updated with
  `texSubImage2D`). Mic levels as R32F texture. Edges/elements rebuild
  every frame (elements may have moved); mic levels always uploaded
  (tiny).

## Sensor FBO

After the TF pass, sensor hits are rendered as 1×1 points into a
`binCount × sensorCount` R32F FBO with additive blending. The sensor
vertex shader reads from the TF buffer (16-float stride), checks
`v_meta.y` (sensor hit flag), and positions hits at `(bin, sensor)` in
clip space. Non-hits are placed off-screen.

`readPixels(RED, FLOAT)` reads the ~6 KB FBO directly into
`sensorBins`. No sync fencing, no double buffering — immediate and
exact. Requires `EXT_color_buffer_float` + `EXT_float_blend`.

A validation probe at init time (`_validateR32FBlend`) renders a known
value into a 1×1 R32F FBO and reads it back. If precision fails
(ANGLE/Intel drivers), sensor accumulation falls back to a CPU
readback path.

GL state (viewport, clearColor, blend, active texture) is saved before
the sensor pass and restored after.

## GLSL physics

The vertex shader implements the same physics as `castRay` in
`raytracer.js`:

- Ray-segment intersection (same `raySeg` formula)
- Snell's law refraction with TIR detection
- Beer-Lambert absorption inside dielectrics
- Wavelength-to-RGB (piecewise, same as `spectrum.js`)
- Sellmeier and Cauchy refractive index
- Material absorption (base + Gaussian band)
- Mirror reflectance (base + Gaussian band)
- Delay element capture (skips — returns for CPU tracer to handle)
- Inside-element stack (fixed size 4)

## Limitations vs CPU tracer

- No delay/particle simulation (particles are stateful, frame-
  persistent — stays on CPU)
- No secondary rays
- Fixed-size inside-element stack (max 4 deep, silent overflow)
- No initial containment check (elements overlapping the left wall)
- Redundant O(B²) prefix re-tracing per ray (each bounce re-traces
  all previous bounces). Acceptable at current ray counts; a ping-
  pong bounce loop would reduce this to O(B).

## Debug / test

- `docs/gpu-test.html`: browser-based test page comparing GPU vs CPU
  tracer output. Runs both tracers on 17 scenes, shows segment
  overlays (CPU blue, GPU orange). Click rows to expand.
- `_debugReadback` flag: when true, the GPU tracer does a synchronous
  `getBufferSubData` to populate `segmentData` for the test page.
  Off in production.
- CPU snapshot infrastructure: `npm run snapshot` generates reference
  snapshots, `npm run verify` compares the CPU tracer against them.

## Known optimization opportunities

- Ping-pong bounce loop: one TF dispatch per bounce instead of
  re-tracing the full prefix per vertex. ~16× trace cost reduction.
- Spatial partition for edges: uniform 32×32 grid as a texture.
- MAX_STACK overflow detection.
- Sensor FBO readPixels via PBO for async readback (currently
  synchronous but only 6 KB so the stall is negligible).
