# Plan: Ping-Pong Bounce Tracer

**Status: IMPLEMENTED** — see `docs/gpu-tracer.js` and
`agent_docs/architecture-gpu-tracer.md` for the current architecture.
Additional optimization applied: `effectiveBounces = min(32, edges+1)`
reduces dispatch count analytically based on scene edge count.

## Original Problem

The current GPU tracer emits one vertex per `(ray, bounce)` pair.
Each vertex re-traces the full ray path from the emitter up to its
bounce index. For a ray that bounces 8 times, bounce 7's vertex
redundantly recomputes bounces 0–6. Total work scales as O(B²) per
ray. With MAX_BOUNCES=32, average prefix length ~B/2, this is a 16×
overhead vs the CPU tracer which traces each ray once.

At 24 sources × 512 rays × 32 bounces = 393k vertices. Most are
degenerate (the ray terminated before that bounce). The TF buffer
is 24 MB. GPU time is ~12× slower than CPU at current scene sizes.

## Solution: one dispatch per bounce

Instead of one monolithic TF pass with B×R vertices, run B separate
TF passes with R vertices each. Each pass reads the ray state from
the previous pass's output and advances one bounce:

```
Pass 0: emit rays from wall → write (pos, dir, I, wl, alive) to buffer A
Pass 1: read A, advance one bounce → write to buffer B, emit segment
Pass 2: read B, advance one bounce → write to buffer A, emit segment
...
Pass B: read, advance, write, emit
```

Each pass processes only R rays (not B×R vertices). Dead rays
(`alive=0`) skip the intersection loop — a single `if` in the VS.
As rays die (wall hit, intensity < threshold), the active count
drops. Later passes are increasingly cheap.

## Data layout

**Ray state buffer** (ping-pong, two buffers A and B):

Per ray: 12 floats
```
[posX, posY, dirX, dirY, I, wl, r, g, b, alive, stackLen, stack0]
```
- `alive`: 1.0 or 0.0. Dead rays skip the bounce.
- `stackLen` + `stack0`: simplified inside-element stack (single
  element index for depth-1 nesting; deeper nesting uses `stack0`
  as the top-of-stack element index, `stackLen` counts depth).
  Full MAX_STACK=4 doesn't fit in 12 floats; either expand to 16
  or limit to depth-1 (covers most scenes).

Total per buffer: `totalRays × 12 × 4` bytes = 24×512×48 = 576 KB.
Two buffers = 1.15 MB. Down from 24 MB.

**Segment output buffer** (append-only):

Each bounce pass appends one segment per alive ray. Segments are
the same 12 floats as now (p1, p2, c1, c2). Use a single large
buffer sized to `totalRays × MAX_BOUNCES × 12 × 4`, same as
current TF buffer. But now it's filled incrementally — pass k
writes at offset `k × totalRays × 48`.

Alternatively, use a separate TF buffer per pass and bind them
sequentially for rendering. Simpler but more buffers.

Best approach: single segment buffer, use `gl.bindBufferRange`
with byte offset for each pass's TF output region. WebGL2 supports
`bindBufferRange` on `TRANSFORM_FEEDBACK_BUFFER`.

**Sensor metadata**: the `v_meta` (wavelength + sensor hit flag)
can be part of the segment output as it is now (16 floats per
segment). Or it can be a separate small buffer that the sensor
FBO pass reads.

## Shader changes

**Bounce vertex shader** (replaces the current monolithic VS):

```glsl
// Input: ray state from previous bounce (read from texture or buffer)
in vec4 a_posDir;    // posX, posY, dirX, dirY
in vec4 a_state;     // I, wl, alive, stackTop
in vec4 a_color;     // r, g, b, stackLen

// Output: updated ray state (TF to the other buffer)
out vec4 v_posDir;
out vec4 v_state;
out vec4 v_color;

// Output: segment for this bounce (TF to segment buffer)
out vec4 v_segP;     // p1x, p1y, p2x, p2y
out vec4 v_segC1;    // r*I, g*I, b*I, I  at p1
out vec4 v_segC2;    // r*I, g*I, b*I, I  at p2
out vec4 v_segMeta;  // wl, isSensor, 0, 0
```

The shader does exactly ONE bounce:
1. If `alive < 0.5`, output degenerate segment + copy state unchanged
2. Find nearest intersection (edge loop + walls)
3. Compute Beer-Lambert absorption along the segment
4. Emit segment (p1→hit)
5. If wall hit: set alive=0, set isSensor flag if sensor wall
6. If element hit: refract/reflect, update dir + stack
7. Advance pos past hit point (pos = hit + dir × EPS)
8. If I < threshold: set alive=0
9. Write updated ray state

## TF configuration

WebGL2 transform feedback with `SEPARATE_ATTRIBS`:
- Binding 0: ray state buffer (ping target)
- Binding 1–3: segment outputs (could use INTERLEAVED within the
  segment group if we pack them)

Actually, `SEPARATE_ATTRIBS` is limited to 4 outputs. We have 7
output varyings (3 ray state + 4 segment). Options:

**Option A**: Two TF passes per bounce.
- Pass A: advance ray, write state to ping buffer (3 varyings).
- Pass B: read the same input state, compute segment, write to
  segment buffer (4 varyings).
- Doubles the dispatch count but each is simpler. 64 dispatches
  instead of 32 for MAX_BOUNCES=32.

**Option B**: Use `INTERLEAVED_ATTRIBS` with all 7 varyings.
- 7 × 4 = 28 floats per vertex. WebGL2 guarantees at least 64
  interleaved components, so 28 fits.
- Single buffer per bounce, split into ray-state region (12 floats)
  and segment region (16 floats) by byte offset when binding for
  the next pass.
- Actually, interleaved means ALL outputs go to ONE buffer
  sequentially. We can't split them across two buffers in
  interleaved mode. So the ray state and segment data are adjacent
  in memory. The next pass reads the ray-state portion as vertex
  input (stride 28×4=112, only first 12 floats used). Wasteful
  but works.

**Option C (recommended)**: `INTERLEAVED_ATTRIBS` for segment output
only (4 varyings, 16 floats). Ray state written via `gl_Position`
trick? No — `gl_Position` is consumed by rasterization.

Actually the cleanest: Use `INTERLEAVED_ATTRIBS` with all 7
varyings (28 floats). The output buffer has stride 112 bytes.
For the next bounce pass, bind the same buffer as vertex input
with stride 112 and read the first 12 floats (ray state). The
remaining 16 floats (segment) are skipped by the attribute
pointers. For rendering, bind with stride 112 at offset 48 (skip
ray state, read segment). For the sensor FBO, same offset.

## Pass 0: ray emission

A special first pass emits rays from wall sources. Input is the
vertex index (encodes source index + ray-within-source). Output is
the initial ray state. No segment emitted (or a degenerate one).
This replaces the emitter setup that's currently in the monolithic
VS.

## Rendering

The renderer currently binds the TF buffer with 16-float stride.
With ping-pong, segments are spread across B bounce passes, each
writing `totalRays` segments at a known offset in a single buffer.
The renderer draws `totalRays × actualBounces` instances, binding
the segment buffer with stride 112 at offset 48.

Or: each bounce pass writes to a contiguous segment-only buffer
(separate from ray state), appending after the previous pass's
segments. The renderer binds this buffer with 16-float stride as
before. Cleanest for the renderer — no stride change needed.

## Implementation steps

1. **New shader**: single-bounce VS with ray state I/O + segment
   output. Port the physics from the current monolithic VS.

2. **Buffer setup**: two ray-state buffers (ping/pong), one
   segment buffer. Use `texStorage2D` patterns from current code.

3. **Pass 0 shader**: ray emission from wall sources.

4. **Bounce loop** in `trace()`: for b = 0..MAX_BOUNCES-1:
   - Bind read buffer as vertex input
   - Bind write buffer + segment region as TF output
   - Run the bounce VS
   - Swap read/write buffers
   - Optionally: query alive count and skip remaining passes
     if all rays dead (requires readback or occlusion query)

5. **Sensor pass**: unchanged — reads from segment buffer.

6. **Renderer integration**: bind segment buffer directly, same
   as current zero-copy path.

7. **Test**: run gpu-test.html, compare against CPU tracer.

## Expected performance

- Vertex count per pass: `totalRays` (not `totalRays × MAX_BOUNCES`)
- Total vertex shader invocations: `totalRays × actualBounces`
  (vs `totalRays × MAX_BOUNCES × avgPrefix` currently)
- For 24×512 rays, 8 avg bounces: 98k invocations vs 393k × 4 =
  1.6M currently. ~16× reduction.
- Buffer size: 1.15 MB (ray state) + 24 MB (segments) = 25 MB.
  Segments could be reduced by lowering MAX_BOUNCES or using a
  compacted append buffer.
- GPU time estimate: 0.5–2 ms for typical scenes on a 4 TFLOP/s
  GPU. Faster than CPU (~17 ms for complex scenes).

## Risks

- WebGL2 `INTERLEAVED_ATTRIBS` with 7 varyings (28 components) is
  within spec (min 64) but untested on all drivers.
- Multiple TF passes per frame may have overhead from
  `beginTransformFeedback` / `endTransformFeedback` calls.
- Early termination (skip passes when all rays dead) requires
  reading back alive count, which adds a sync point. Could use
  occlusion query as a proxy (zero fragments drawn = all dead).
- The inside-element stack is limited to 1 entry in the 12-float
  ray state. Deeper nesting requires expanding to 16 floats.
