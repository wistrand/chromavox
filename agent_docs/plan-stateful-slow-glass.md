# Plan: Stateful Slow Glass (Phase 3)

Status: **Shipped, 2026-04-16.** Phase 2's chase clock, onset
detector, `delayFingerprint` re-arm path, per-voice `DelayNode`, and
segment `tStart`/`tEnd` timing fields have all been removed. Optical
delay now comes from a per-element particle pool advanced in real
time each frame; trail segments render inside the glass via the same
ray shader as the ribbons outside.

## Why

Phase 2 animates the *steady-state* result of a single trace. It has no
memory of past frames, so:

- Releasing a keyboard note makes in-flight "delayed" light vanish
  instantly — the tracer retraces from scratch with zero input intensity
  and produces empty sensor events. The DelayNode tail keeps the audio
  audible for up to 2 s but it's the synth voice's own output being
  echoed, not real optical delay.
- Dragging a slow-glass element into a ray path updates the steady-state
  rays each frame, but because `uTvisual` is page-load-old, the chase
  never re-animates until the user releases the pointer.

Both complaints are rooted in the same missing concept: light should
*persist* inside delay materials for `delayK × path-length` seconds, and
that persistence should carry with the element if it moves.

Phase 3 replaces the animation with a real time-stepped simulation. Each
delay element owns a pool of photon particles in the element's *local*
coordinate frame. Particles advance one step per frame; they exit the
polygon as secondary rays that re-enter the normal tracer. The chase
clock, onset detector, fingerprint gating, and synth-side `DelayNode`
all become redundant and come out.

## Locked-in design

- **Rendering**: short trailing segment per particle, injected into the
  existing ray segment buffer (Option B from the analysis). Reuses the
  ray vertex / fragment shader — no new draw pass, no particle-sprite
  shader. Keeps Phase 1's ribbon aesthetic: the ribbon continues through
  the glass interior, just at local-delay-propagation speed.
- **Particle frame**: element-local coordinates. Position + direction
  stored in local. Advanced in local. Transformed to world only at
  emission (segment draw) and at exit (secondary ray). Moving,
  rotating, or scaling the element implicitly carries its held light.
- **Single-attachment rule**: each particle belongs to the element it
  entered. Overlapping another delay element mid-flight does not
  re-attach. Element deletion drops the pool (no free-ray emission).
- **Particle storage**: flat `Float32Array` per element, 8 floats per
  record:
  `[lx, ly, ldx, ldy, I, wl, lastLx, lastLy]`. `lastLx`/`lastLy` are
  last-frame local position — used to emit the "trailing segment" back
  to the ray buffer each frame. Grow-on-demand ring or compact-on-exit.
- **Primary-ray capture at entry**: when `castRay` hits an edge of a
  delay element from outside and refracts inward, instead of continuing
  through, the tracer appends a particle (local entry point, local
  refracted direction, current `I`, `wl`) and terminates that primary
  ray path. No primary-ribbon segments exist inside the glass.
- **Secondary-ray emission at exit**: when a particle's advance step
  crosses a local polygon edge, clip to the edge, refract from the
  element's `n(λ)` to the outside medium (re-use the inside-stack
  logic at the exit world point with the element popped), and enqueue
  a world-space emission that joins the frame's normal `castRay`
  invocations. TIR at exit: reflect in local space and keep the
  particle alive.
- **Trail-segment emission**: each advance step pushes one segment
  `(lastLx,lastLy) → (lx,ly)` (transformed to world) into the shared
  ray segment buffer, with color = `wavelengthToRGB(wl) × I`. Same
  shader as primary ribbons. At 60 fps this gives a ~1-bench-unit
  dash per particle per frame — dense enough to read as a continuous
  ribbon at the default 6 k rays / frame.
- **Time**: wall time is the only clock. No `uTphysical` /
  `uTvisual` / `chaseStart` / `lastRenderedT`. A particle entering at
  wall time `t_enter` with local path `L` exits at
  `t_enter + L / (1/delayK) = t_enter + L·delayK`. Sensor events carry
  their `wallTime` in place of `rayTimeVisual` (or just deposit
  directly since there is no gate).
- **Audio delay**: driven purely by sensor deposit timing. Phase 1's
  per-voice `DelayNode` is removed. The synth's dry path is the only
  path. Releasing a note still produces sensor deposits as particles
  drain, so the synth voices hold on naturally.
- **Sim-rate slider** (repurposed from Phase 2's visual-rate slider):
  global multiplier applied to particle advance speed. `4×` makes
  slow-glass drain 4× faster; `0.25×` makes it 4× slower. Log scale,
  default 1×. The **Onset sensitivity** slider goes away entirely.
- **Mic onset detector**: removed. There is no chase to re-arm.
- **Re-arm hook and delay fingerprint**: removed. `UI.onRearm`,
  `delayFingerprint`, the fourth-argument callback in `UI` constructor,
  and the `delayChanged` branch in `History.commit` all come out.
- **Phase 2 segment layout**: 14-float segments revert to 12 floats.
  The `aTime` attribute, `uT` / `uHeadWidth` uniforms, and fragment
  `discard` are removed from the ray shader.
- **Chase-related documentation**: the Phase 2 "chase clock" sections
  in `architecture-overview.md`, `-raytracer.md`, `-audio.md` are
  rewritten as Phase 3 simulation sections.

## Files to touch

| File | Direction | Estimate |
| --- | --- | --- |
| `docs/raytracer.js` | +particle pools, advance pass, entry capture, exit emission, trail segments, containment grid. Remove chase `tStart/tEnd`, event-log gating, `maxT`, `totalEnergy`. | +300 / −140 |
| `docs/renderer.js` | Drop `aTime`, `uT`, `uHeadWidth`, fragment `discard`; segment stride 14 → 12; draw path unchanged otherwise. | +5 / −70 |
| `docs/main.js` | Drop chase clock, onset detector, gated reconstruction, fingerprint hooks. Add `simRate` slider wiring. Frame loop runs while any particle pool is non-empty OR scene is dirty. | +30 / −140 |
| `docs/ui.js` | Drop `delayFingerprint`, `onRearm`, `delayChanged` branch. `endEdit` returns `void` again. | −40 |
| `docs/synth.js` | Drop wet/dry split, per-voice `DelayNode`, `sensorDelay` param. Voices reconnect `voiceMix → master` direct. | −60 |
| `docs/spectrum.js` | Unchanged — `delayK` field and accessors still valid. | 0 |
| `docs/play.html` | Replace Onset-sensitivity slider with nothing; rename Visual-rate label to "Sim rate". | ~3 lines |
| `agent_docs/architecture-raytracer.md` | Rewrite Phase 2 sections as Phase 3: particle pools, advance pass, entry capture, exit emission. | major |
| `agent_docs/architecture-audio.md` | Rewrite Phase 2 chase-gating section: audio delay now falls out of sensor-deposit timing; `DelayNode` is gone. | section |
| `agent_docs/architecture-overview.md` | Render-loop section: drop chase clock; simulation clock is wall time; idle when no particles + no dirty. | section |
| `agent_docs/architecture-ui.md` | Drop fingerprint + onRearm section. | section |
| `agent_docs/architecture-gotchas.md` | Replace Phase 2 gotchas with Phase 3 ones (grid early-out, single-attachment rule, element-delete drops pool). | section |
| `agent_docs/plan-delay-materials.md` | Mark Phase 2 as superseded; cross-link to this plan. | header |

Net change: roughly −100 lines of code across the app, +meaningful amount
of new tracer logic. Phase 2 retired entirely.

## Implementation phases

### Phase 3A — particle pools and local-space advance (no visuals, no synth change yet)

Goal: a delay element holds a pool of particles in its local frame,
and each frame they advance + containment-test. Exit events are
queued but not yet fed back into the tracer. Synth + renderer keep
working off the old path for the moment (Phase 2 still active).

- `raytracer.js`: `ParticleBuffer` class (constructor given `elementId`,
  grow-on-demand `Float32Array`). Methods:
  `add(lx, ly, ldx, ldy, I, wl)`, `advance(dt, el, mat, simRate)`
  that walks the buffer, steps positions, decays intensity, runs
  `pointInPolygon` (against `el.localPolygon`), collects exits.
- `Tracer` holds `this._pools = new Map<elId, ParticleBuffer>()`. On
  `trace()`, sync pools to current scene (drop entries for deleted
  ids; create new ones lazily on first capture).
- At this stage, entry capture is faked: for debugging, every N-th
  primary ray that enters a delay element spawns a particle. Advance
  runs but exits are only logged.

Ship-ready when: placing a slow-glass shows `pool.count` in a debug
overlay; dragging the element carries the count smoothly (particles
stay "attached"); advancing a few hundred particles per frame stays
under 1 ms.

### Phase 3B — entry capture + secondary-ray emission

Goal: the tracer captures real rays at entry and re-emits them on
exit. Sensors receive the full delayed deposit. Visuals of the
interior still come from Phase 2's scaffolding (which stays in place
one more phase).

- `raytracer.js` `castRay`: on a dielectric boundary hit where the
  material has a `delayK`, transform the refracted inward direction
  to element-local, add to the element's pool, return (no further
  bounces for this primary ray).
- In `trace()`, after primary pass, drain each pool's exit queue:
  transform each exit world-space, run Snell exit against the
  popped-stack outside medium, enqueue as a secondary emission, and
  run `castRay` again for each secondary emission through the normal
  pipeline. Sensor events get populated as usual.
- Keep Phase 2's 14-float segments / `uT` / onset detector in place.
  Particles don't yet emit trail segments.

Ship-ready when: hitting a key, releasing it, and listening confirms
audio continues for the expected `delayK × path` duration with no
`DelayNode` in the path; moving the glass during sustained input
shows the expected "wavefront carried with element" behaviour on
the synth side (sensor histogram reflects stored photons as they
drain).

### Phase 3C — trail segment emission, retire chase visuals

Goal: interior-of-glass visuals come from per-particle trail
segments; Phase 2's animation infrastructure is removed wholesale.

- `raytracer.js` `advance`: for each particle, push a 12-float
  segment `(lastLx,lastLy) → (lx,ly)` (world-transformed) into the
  shared segment buffer. Colour = `wavelengthToRGB(wl) × I`. Update
  `lastLx/Ly` after emission.
- Segment layout reverts 14 → 12 floats. Rayshader loses `aTime`,
  `uT`, `uHeadWidth`, `discard`.
- `main.js`: remove chase clock, gated reconstruction, onset
  detector, and the visual-rate slider's "phase accumulator". Add
  `simRate` slider wired into `tracer._simRate` (multiplier applied
  to `dt` in advance).
- `ui.js`: remove `delayFingerprint`, `onRearm`, `delayChanged`.
- `synth.js`: delete wet/dry split and per-voice `DelayNode`. Voices
  go `voiceMix → master`.
- `play.html`: remove Onset-sensitivity slider; rename Visual-rate
  to Sim-rate.
- Docs: rewrite sections listed above.

Ship-ready when: Phase 2 chase is gone from the codebase; a
no-delay scene looks and performs exactly as it did before Phase 2;
a delay scene shows a ribbon that crawls through the glass at local
delay speed, persists when input stops, and carries with the element
on drag — with audio timing matching the visual arrival.

### Phase 3D (optional) — performance

Guard for low-end hardware:

- Local coarse grid inside each element's AABB so most
  `pointInPolygon` calls are O(1) (inside-cell / outside-cell / near-
  boundary-cell). Only near-boundary cells run the full polygon test.
- Per-element max-particle cap (hard ceiling) to prevent pathological
  explosions (e.g., huge `delayK` + huge path + many rays).
- Optional particle sub-sampling: emit a trail segment every Nth
  frame per particle to reduce segment count when density is high.

Ship-ready when: a stress scene (12 sources × 512 rays, `delayK =
0.005`, long path) holds 60 fps on a reference mid-range mobile
device.

## Subtle interactions

- **Dry-only synth changes the tonal character** vs. the Phase 1 wet
  tail. The DelayNode was adding a reverb-like sustain to voices that
  masked envelope abruptness. With it gone, releasing a note gives a
  harder attack/release on the synth side, then the delayed sensor
  deposits paint a fresh bloom as they arrive. Label expectations in
  docs; consider a separate reverb send if it feels too dry.
- **`delayK` change mid-flight** applies to the next advance step, not
  retroactively. A particle halfway through a 0.5 s crossing at
  `delayK = 0.002` when the slider jumps to `0.004` finishes its
  remaining half at the slower rate. Physically odd, interactively
  natural.
- **Element rotation / scale during flight** transforms all held
  particles implicitly (they're in local coords). Scaling a slow-glass
  larger effectively stretches the held wavefront; shrinking compresses
  it. Users will probably treat this as a feature.
- **Element deletion** drops the pool entirely. In-flight light
  vanishes. Alternative (emit all held particles as free rays at
  their current world position) was considered and rejected as a
  hazard for undo/redo semantics — restoring a deleted element would
  leave both the re-created pool AND the orphan particles.
- **Stress case: near-TIR entry**. A ray that nearly TIRs at entry is
  captured with very small remaining `I` after `GLASS_LOSS`. These
  particles may die on the first absorption step. Fine — they never
  would have reached the far side anyway.
- **Exit into another delay element**. A particle exits element A,
  becomes a secondary ray, and the secondary ray's `castRay` hits
  element B's boundary. Same entry-capture path fires — particle now
  attached to B. Chains correctly.
- **Secondary ray hits the same element again** (e.g., a concave
  slow-glass that bends light back into itself). The secondary ray's
  entry capture creates a new particle in the same element; not the
  same object as the original. Fine — doubles the held count in that
  element, which is physically correct.
- **No primary ribbon inside the glass**. Renderer interior comes
  entirely from trail segments. If particle density is very low
  (mic input near silent, or `delayK` extreme), the ribbon gets
  sparse. With `raysPerSource = 512` and `delayK = 0.002`, steady-
  state density is ~6 particles per bench unit along the path —
  plenty dense.
- **Exit refraction uses the popped-stack outside medium**, same as
  the primary tracer's exit path. Nesting a slow-glass inside a
  water block: particle exits slow-glass boundary, sees "water" as
  outside, Snell against water's `n`. Correct physics.
- **`raysPerSource` and sim scale interact**. Doubling rays doubles
  particle density. `simRate > 1` drains particles faster, reducing
  steady-state count. Be explicit in docs so power users can tune.
- **History / undo across a particle-in-flight**. Undo restores the
  scene to an earlier state; pools for now-gone elements drop; pools
  for still-present elements keep their current particles. That means
  undo doesn't rewind the photon field — it snaps geometry only.
  Acceptable; rewinding the photon field would require recording
  particle history too.

## Choices deferred

- **Particle sprite rendering** (Option A) vs. trail segments. Keeping
  the option open: the same particle data can drive either renderer.
- **Full stateful global simulation** (all optics run on particles,
  not just `delayK` elements). Lenses and mirrors today are still
  stateless because light crosses them instantly at `VACUUM_PROP_K =
  0`. Promoting everything to particles is conceptually cleaner but
  would require the entire tracer to be rewritten around a Lagrangian
  solver. Out of scope.
- **Wavelength-dependent velocity** (`v(λ) ∝ 1 / n(λ)`). Same deferred
  call as in Phase 2.
- **Per-element `simRate` override** vs. the global slider.
- **Mic → input delay-tap** (echo the raw mic, not the synth voice).
  The original Phase 1 alternative. With stateful slow-glass, the
  synth's dry signal already reflects the delayed sensor deposits;
  a separate input-echo feature would be additive, not a replacement.

## Why each pick over the alternative

| Pick | Alternative | Why this |
| --- | --- | --- |
| Per-particle trail segments (B) | Instanced particle sprites (A) | Reuses the existing ray shader / buffer; no new draw pass; keeps the ribbon aesthetic. |
| Local-space particles | World-space particles | Moving or rotating the element carries held light correctly — exactly what the user expected. |
| Single-attachment | Re-attach on overlap | Avoids re-attachment races during drags through adjacent elements. |
| Wall-time clock | Preserve Phase 2 dual clocks | There is no animation to schedule. One clock matches one simulation. |
| Drop `DelayNode` | Keep for safety | Double-delay would be a bug; the physics now does the work. |
| Retire chase entirely | Keep chase + simulation side-by-side | Two mental models for the same feature confuses both users and the code. |
| Primary capture at entry | Primary-traces-through + parallel particles | Prevents double-counting on the sensor side and keeps the ribbon visual coherent. |
| Coarse grid early-out (3D) | Full polygon test per particle per frame | O(1) common case; only the near-boundary bucket runs the expensive test. |
