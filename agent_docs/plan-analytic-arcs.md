# Plan: Analytic Arc Intersection

Replace polygon-facet approximations of circular arcs with analytic
ray-arc intersection in both CPU and GPU tracers. Benefits all curved
elements (lenses, circles) and enables clean curved mirrors.

## Motivation

Lenses are 24-segment polygon approximations. Reflection doubles normal
error vs refraction, so curved mirrors would produce visible banding
with the same approach. Analytic arcs give exact normals, eliminate
facet artifacts, and dramatically reduce edge count (convex lens:
48 edges -> 2 arcs; circle: 128 -> 1).

Fewer edges also reduces GPU tracer dispatch count via
`effectiveBounces = min(32, edges.length + 1)`.

---

## Phase 1: Data model — arc edges in `worldEdges`

**Files:** `scene.js`

**Goal:** `worldEdges` emits mixed edge types (segments and arcs).
`localPolygon` stays unchanged for rendering, hit-testing, and overlap.

1. Define arc edge shape: `{ type: 'arc', cx, cy, R, a0, a1, convex, elementId }`.
   `a0`/`a1` are world-space angles of the arc endpoints (start/end in
   winding order). `convex` flag (true = outward-bulging, normal points
   away from center; false = concave, normal toward center).
   Existing segment edges get `{ type: 'seg', p1, p2, nx, ny, elementId }`.

2. New helper `worldArcEdges(el)` returns `{ edges: [...], polygon }` where
   edges is the mixed array. Called from the same places `worldEdges` is
   called today. Polygon stays the dense vertex list for `pointInPolygon`.

3. For `lens-convex`: emit 2 arc edges (left and right arcs). Arc center,
   radius, and angular extent derived from the same parameters
   `localPolygon` uses today. Transform center by element rotation/position.
   Angles rotated by `el.rot`.

4. For `lens-concave`: 2 arc edges (concave surfaces) + 4 segment edges
   (top/bottom flat caps).

5. For `circle`: 1 full-circle arc edge (a0=0, a1=2pi).

6. For `prism`, `block`, `mirror`, `rabbit`: segment edges only
   (unchanged).

**Validation:** Unit-check that arc edge parameters match the polygon
vertices (arc endpoints should coincide with the first/last polygon
vertex of each arc section, within floating-point tolerance).

---

## Phase 2: CPU tracer — `rayArc` intersection

**Files:** `raytracer.js`

**Goal:** CPU tracer handles mixed edge types.

1. Add `rayArc(ox, oy, dx, dy, cx, cy, R, a0, a1)`:
   - Solve `|P + t*D - C|^2 = R^2` -> quadratic in `t`.
   - Two candidate `t` values; for each, check `t > EPS` and hit angle
     within `[a0, a1]` (handling wrap-around).
   - Return smallest valid `t`, or `null`.
   - Normal at hit: `(hx - cx, hy - cy) / R`, negated if concave.

2. Main trace loop (line ~638): branch on `e.type`:
   ```
   const t = e.type === 'arc'
     ? rayArc(x, y, vx, vy, e.cx, e.cy, e.R, e.a0, e.a1)
     : raySeg(x, y, vx, vy, e.p1.x, e.p1.y, e.p2.x, e.p2.y);
   ```

3. When hit edge is an arc, compute normal from hit point instead of
   reading `e.nx, e.ny`:
   ```
   const hx = x + vx * tBest, hy = y + vy * tBest;
   let nx = (hx - hitEdge.cx) / hitEdge.R;
   let ny = (hy - hitEdge.cy) / hitEdge.R;
   if (!hitEdge.convex) { nx = -nx; ny = -ny; }
   ```

4. `segSegT` (particle advance for delay elements): add `segArcT`
   variant. Same quadratic but parameterized on the particle step
   segment `(x1,y1)->(x2,y2)` instead of a ray origin+direction.

**Validation:** Place a convex lens. Compare CPU tracer output before
(polygon edges) and after (arc edges). Refracted rays should be
smoother — no facet discontinuities. Sensor deposits should be
continuous.

---

## Phase 3: GPU tracer — GLSL `rayArc`

**Files:** `gpu-tracer.js`

**Goal:** GPU tracer handles mixed edge types via tagged union in edge
texture.

1. **Edge texture format change.** Row 1, float 3 (currently always `0`)
   becomes the type flag: `0.0` = segment, `1.0` = arc.

   Segment (unchanged layout):
   - Row 0: `(p1.x, p1.y, p2.x, p2.y)`
   - Row 1: `(nx, ny, elIdx, 0.0)`

   Arc:
   - Row 0: `(cx, cy, R, convex)` — convex is 1.0 or 0.0
   - Row 1: `(a0, a1, elIdx, 1.0)`

2. **`_uploadEdges`**: branch on `e.type` when filling the texture data
   arrays. Same texture, same stride, same `texSubImage2D` calls.

3. **GLSL `rayArc` function** (~15 lines):
   ```glsl
   float rayArc(vec2 o, vec2 d, vec2 c, float R, float a0, float a1) {
     vec2 oc = o - c;
     float a = dot(d, d);
     float b = dot(oc, d);
     float cc = dot(oc, oc) - R * R;
     float disc = b * b - a * cc;
     if (disc < 0.0) return -1.0;
     float sq = sqrt(disc);
     float t1 = (-b - sq) / a;
     float t2 = (-b + sq) / a;
     // Check both candidates: valid t and within angular extent
     for (int k = 0; k < 2; k++) {
       float t = k == 0 ? t1 : t2;
       if (t <= EPS) continue;
       vec2 hp = o + d * t;
       float ang = atan(hp.y - c.y, hp.x - c.x);
       if (angleInRange(ang, a0, a1)) return t;
     }
     return -1.0;
   }
   ```

4. **`angleInRange` helper** — handles wrap-around:
   ```glsl
   bool angleInRange(float a, float a0, float a1) {
     // Normalize to [0, 2pi)
     a  = mod(a  - a0, 6.2831853);
     float span = mod(a1 - a0, 6.2831853);
     return a <= span + 1e-4;
   }
   ```

5. **Main loop branch** (line ~257):
   ```glsl
   for (int i = 0; i < u_edgeCount; i++) {
     vec4 ep = edgeEndpoints(i);  // row 0
     vec4 en = edgeNormal(i);     // row 1
     float type = en.w;
     float t;
     if (type > 0.5) {
       t = rayArc(pos, dir, ep.xy, ep.z, en.x, en.y);
     } else {
       t = raySeg(pos, dir, ep.xy, ep.zw);
     }
     if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = i; hitWallKind = -1; }
   }
   ```

6. **Normal computation after hit**: when `hitEdgeIdx >= 0`, read edge
   type. For arcs, compute normal from hit point and center:
   ```glsl
   vec2 n;
   if (hitType > 0.5) {
     vec4 ep = edgeEndpoints(hitEdgeIdx);
     n = normalize(hit - ep.xy);
     if (ep.w < 0.5) n = -n;  // concave: flip normal
   } else {
     vec4 en = edgeNormal(hitEdgeIdx);
     n = en.xy;
   }
   ```

**Validation:** GPU test page (`gpu-test.html`). Place convex lens,
compare CPU vs GPU segment output. Should match within tolerance.
Run existing snapshot tests.

---

## Phase 4: Curved mirror elements

**Files:** `scene.js`, `play.html`, `main.js`, `style.css`

**Goal:** Add `mirror-concave` and `mirror-convex` element kinds.

1. `createElement('mirror-concave')`: `{ h: 80, radius: 160, material: 'mirror' }`.
   `createElement('mirror-convex')`: same defaults.

2. `localPolygon`: generate polygon approximation for rendering/hit-test
   (like lenses, but thinner — a chord cap + arc). Used only for
   visual outline and `pointInPolygon`.

3. `worldArcEdges`: one reflective arc edge + two short flat end-caps.
   The arc edge gets the mirror material via `elementId`.

4. Add to toolbar dropdown in `play.html` (after existing mirror entry):
   ```html
   <div class="tool-menu-item" data-tool="mirror-concave">
     <span class="tmi-label">Concave Mirror</span>
   </div>
   <div class="tool-menu-item" data-tool="mirror-convex">
     <span class="tmi-label">Convex Mirror</span>
   </div>
   ```

5. Renderer `LOOK` entries — same tint as flat mirror, arc outline
   drawn from the polygon vertices.

6. Property panel: expose `radius` slider for curved mirrors (reuse
   lens radius UI, constrain to >= h to keep arc valid).

**Validation:** Place concave mirror, aim a single-source beam at it.
Should see smooth convergence to a focal point (R/2). No facet banding.
Convex mirror should produce smooth divergence.

---

## Phase 5: Cleanup and edge-count optimization

**Files:** `scene.js`, `gpu-tracer.js`, `raytracer.js`

1. Verify `effectiveBounces` benefits from reduced edge count. A scene
   with two convex lenses goes from ~96 edges to ~4 arcs + 0 segments
   = 5 edges -> `effectiveBounces` drops from ~97 to ~6. Measure FPS.

2. Consider full-circle optimization: for `circle` elements, skip the
   angular range check entirely (always hits). Special `type = 2.0` or
   just set `a0=0, a1=2*PI`.

3. Update `elementsOverlap` / `edgesIntersect` if needed — these use
   the polygon from `worldEdges`, not the arc edges. If we keep using
   `worldEdges` (polygon) for overlap and only use arc edges in the
   tracer, no changes needed. Document this split.

4. Run full snapshot suite. Update reference snapshots (arc intersection
   produces slightly different ray paths than polygon approximation).

5. Update `agent_docs/architecture-raytracer.md`,
   `architecture-gpu-tracer.md`, `architecture-elements.md`.

---

## Dependency graph

```
Phase 1 (data model)
  |
  +---> Phase 2 (CPU tracer)
  |       |
  |       +---> Phase 4 (curved mirrors, needs CPU working)
  |
  +---> Phase 3 (GPU tracer, independent of Phase 2)
          |
          +---> Phase 4 (curved mirrors, needs GPU working)

Phase 5 (cleanup) after Phase 4
```

Phases 2 and 3 can be done in parallel. Phase 4 needs both. Phase 5
is post-validation.

---

## Risk notes

- **Angle wrap-around** is the main correctness trap. Arcs that cross
  the -PI/+PI boundary need careful modular arithmetic. Both `rayArc`
  implementations must handle this. Test with a rotated lens where the
  arc straddles angle 0.

- **`pointInPolygon` stays polygon-based.** The dense vertex list from
  `localPolygon` is kept for hit-testing, overlap detection, and
  rendering. Only the tracer switches to arcs. Two representations of
  the same shape — keep them in sync.

- **Delay element particles** use `segSegT` for edge crossing. If a
  delay element has arc edges (unlikely — delay is currently only on
  dielectric polygons), `segArcT` is needed. Low priority unless
  delay is extended to lenses.

- **Snapshot tests will break.** Arc intersection produces slightly
  different ray paths than 24-segment polygons. Regenerate snapshots
  after Phase 2 is validated visually.
