# Architecture: GPU Tracer

## Overview

`docs/gpu-tracer.js` is a WebGL2 transform-feedback ray tracer using
a ping-pong bounce architecture. Default tracer when no delay elements
are present; `main.js` auto-switches to the CPU tracer when delay
elements are added (`pickTracer()` in the frame loop). The left panel
shows "Tracer: GPU" or "Tracer: CPU". Force CPU with `?cpu` URL param.

## Ping-pong bounce pipeline

Instead of one monolithic TF pass that re-traces the full ray prefix
per vertex (O(B²)), this runs one TF dispatch per bounce with
`totalRays` vertices. Each dispatch reads the previous bounce's ray
state and advances one step. Total work: `totalRays × actualBounces`.

**Effective bounce count**: `min(MAX_BOUNCES, edges.length * 3 + 2)`.
The `* 3` factor accounts for TIR bounces with fewer arc edges (analytic
arcs replace many polygon segments, but rays can still TIR multiple times
inside a curved element). Empty scene: 2 dispatches. Single prism: 5.
This directly controls dispatch count, segment buffer size, and memory.

**Buffer layout**:
- Two ping-pong buffers (`_ppBufs[0]`, `_ppBufs[1]`): each sized
  `totalRays × 96 bytes` (24 floats: 8 ray state + 16 segment).
  Read from one, TF writes to the other. Never used simultaneously
  for read and write — satisfies Chrome's strict buffer aliasing rule.
- One segment buffer (`_segBuffer`): `effectiveBounces × totalRays ×
  96 bytes`. Each bounce's full PP output is copied here via
  `copyBufferSubData`. The renderer draws from this buffer.
- Pre-built VAOs: one per ping-pong buffer (attribs permanently bound)
  plus one for bounce 0 (no input attribs, uses `gl_VertexID`).
- Pre-built TF objects: one per write buffer, bindings set once.

**Per-bounce dispatch**:
1. Bind VAO that reads from the read buffer (or VAO0 for bounce 0)
2. Bind TF object that writes to the write buffer
3. `beginTransformFeedback` / `drawArrays` / `endTransformFeedback`
4. `copyBufferSubData` from write buffer to segment buffer region
5. Swap read/write for next bounce

## Ray state

Per ray: 8 floats in two vec4s:
- `v_rayPosDir`: posX, posY, dirX, dirY
- `v_rayState`: I (intensity), wl (wavelength), alive (0 or 1),
  packedStack (inside-element stack, depth-3, packed into one float)

The inside-element stack is packed as:
`stackLen * 262144 + stack[0] * 4096 + stack[1] * 64 + stack[2]`.
Element indices 0-63, max packed value 1,056,831 — exact in fp32
integer range (2^24). Slots beyond `stkLen` are garbage but never
read. GLSL helpers: `unpackStack()`, `packStack()`, `stkPush()`,
`stkPop()`, `stkTop()`.

RGB is recomputed from wavelength each bounce via `wlToRGB()`.
Dead rays (`alive < 0.5`) pass through without intersection testing.

## Sensor FBO

After the bounce loop, sensor hits are rendered as 1×1 points into a
`binCount × sensorCount` R32F FBO with additive blending. The sensor
VS reads from the segment buffer (stride 96, offset 32 for segment
data), checks `v_segMeta.y` (sensor hit flag), places hits at
`(bin, sensor)` in clip space.

`readPixels(RED, FLOAT)` reads the ~6 KB FBO into `sensorBins`.
Requires `EXT_color_buffer_float` + `EXT_float_blend`. If either
extension is absent (common on some mobile GPUs for `EXT_float_blend`),
the GPU tracer sets `_ready = false` and `main.js` falls back to the
CPU tracer entirely — a GPU tracer without working sensor accumulation
would produce silent audio. A `console.warn` names the missing
extension for diagnosis.

Sensor pass leaves blend/viewport/program dirty. The renderer's
`draw()` sets its own state before drawing (documented as a
postcondition of `trace()` at the class level).

## Tagged union edge texture

`_uploadEdges()` packs both segment and arc edges into the same 2-row
RGBA32F edge texture. The type flag lives in row 1, float w:

- **Segment** (type flag = 0.0): row 0 `(p1x, p1y, p2x, p2y)`,
  row 1 `(nx, ny, elIdx, 0.0)`.
- **Arc** (type flag = 1.0): row 0 `(cx, cy, R, convex)`,
  row 1 `(a0, a1, elIdx, 1.0)`.

The main intersection loop in GLSL branches on `edgeType > 0.5`.
`rayArc()` solves the quadratic ray-circle intersection and calls
`angleInRange()` for the angular bounds check (handles wrap-around).
Post-hit normal reads the edge type: arcs derive normal from
`(hit - center) / R`, flipped for concave; segments use the stored
`(nx, ny)`.

## GLSL physics

The vertex shader implements the same physics as `castRay` in
`raytracer.js`:

- Ray-segment intersection (`raySeg`)
- Ray-arc intersection (`rayArc`) with angular range check
- Snell's law refraction with TIR detection
- Beer-Lambert absorption inside dielectrics
- Wavelength-to-RGB (piecewise, matches `spectrum.js`)
- Sellmeier and Cauchy refractive index
- Material absorption (base + Gaussian band)
- Mirror reflectance (base + Gaussian band)
- Delay element capture (skips — CPU handles particles)
- Inside-element stack (depth-3, packed into one fp32 float)

Bounce 0 uses `gl_VertexID` to compute emitter position, wavelength,
and mic gain. Subsequent bounces read ray state from input attribs.

## Performance

GPU tracer is faster than CPU in all scenarios:

| Scene | Bounces | CPU | GPU | Speedup | Memory |
|-------|---------|-----|-----|---------|--------|
| Empty | 1 | 0.66 ms | 0.02 ms | 43x | 3.4 MB |
| Single prism | 4 | 2.0 ms | 0.06 ms | 33x | 6.8 MB |
| Complex (5 elem) | 19 | 17 ms | 0.29 ms | 59x | 24 MB |
| Dense (10 elem) | 32 | 61 ms | 0.50 ms | 122x | 38 MB |
| Max (64×2k rays) | 32 | 638 ms | 0.73 ms | 870x | 398 MB |

GPU time is dominated by dispatch overhead (~15μs per bounce), not
computation. The `effectiveBounces` optimization reduces dispatch
count from 32 to `edges + 1`, making simple scenes near-free.

## Limitations vs CPU tracer

- No delay/particle simulation (frame-persistent state — stays on CPU)
- No secondary rays
- Inside-element stack: depth-3 (packed fp32; CPU has depth-4)
- No initial containment check (elements overlapping the left wall)

## Debug / test

- `docs/gpu-test.html`: browser-based comparison page. Runs both
  tracers on multiple scenes (including lens and mirror presets), shows
  segment overlays (CPU blue, GPU orange). Bench dimensions are dynamic
  (read from each scene, not hardcoded). Click rows to expand to full
  bench-size canvases.
- `_debugReadback` flag: enables synchronous `getBufferSubData` to
  populate `segmentData` for the test page. Off in production.
- `npm run snapshot` / `npm run verify`: CPU tracer reference snapshots.

## Known optimization opportunities

- Spatial partition for edges: uniform 32×32 grid as a texture.
  Reduces edge intersection from O(edges) to O(~4) per bounce.
- Early termination: skip remaining bounce passes when all rays dead
  (requires alive-count readback or occlusion query).
- Per-bounce copy elimination: `SEPARATE_ATTRIBS` to TF ray state
  into ping-pong buffer and segments directly into `_segBuffer` via
  `bindBufferRange`, skipping `copyBufferSubData`. Requires shader
  restructuring.
- Sensor FBO readPixels via PBO for async readback (6 KB stall is
  negligible but could be eliminated).
- GL object lifecycle: VAOs and TF objects are properly deleted on
  buffer resize. Old objects are `deleteVertexArray`/
  `deleteTransformFeedback`'d before nulling to prevent leaks.
