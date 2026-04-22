# Architecture: Delay Materials

## Overview

Any dielectric material can carry a `delayK` field (seconds per bench
unit of internal path). Elements with `delayK ≥ DELAY_MIN` (0.0003)
trigger the **stateful particle simulation**: primary rays that cross
the boundary are captured as photon records, advanced one step per
frame inside the element's local coordinate frame, and re-emitted as
secondary rays when they exit. Below the threshold the element is
treated as a normal (instant-transit) dielectric.

The shipped material `slowGlass` has `delayK = 0.002`. A per-element
`el.delayK` slider in the property panel lets any dielectric carry a
delay override; the `×` button zeros it.

## Material schema

`delayK` lives alongside the existing Sellmeier/Cauchy dispersion and
Beer-Lambert absorption fields in `MATERIALS` (`docs/js/spectrum.js`).
Accessors: `materialDelay(mat)` returns the material's base value;
`elementDelay(el, mat)` returns the per-element override if set, else
the material default. The particle simulation reads the effective
value via `elementDelay` at capture time and during the advance pass.

No new `type` value — delay elements remain `type: 'dielectric'` and
compose with refraction + absorption naturally. The UI material
dropdown filters by `dielectric` / `mirror`; nothing changes there.

## Particle simulation

### Storage

Each delay element owns a `ParticlePool` (keyed by `el.id` in
`tracer._pools`). Records are a flat `Float32Array`, 11 floats each:

```
[lx, ly, ldx, ldy, I, wl, lastLx, lastLy, r, g, b]
```

- `lx, ly` — current position in element-local coordinates.
- `ldx, ldy` — direction (constant unless TIR at an internal face).
- `I` — intensity, decayed per step by Beer-Lambert.
- `wl` — wavelength (nm), used for exit refraction (`materialN`).
- `lastLx, lastLy` — previous frame's position, for trail segment
  emission.
- `r, g, b` — pre-computed `wavelengthToRGB(wl)` at capture time so
  the advance hot loop never allocates.

Compact-on-remove via swap-with-last.

### Entry capture

In `castRay`, when a primary ray hits a dielectric edge with
`delayK ≥ DELAY_MIN` from outside:

1. Refract once (Snell, `n1` from the inside-stack or vacuum, `n2`
   from the delay material) to get the inward world direction.
2. Transform the world hit point and refracted direction to element-
   local coordinates via `el.rot`, `el.x`, `el.y`.
3. Append a record to the pool (`pool.add(...)`). Seed `lastLx/Ly`
   to the entry point.
4. Terminate the primary ray — no segments inside the glass from the
   primary pass.

TIR at entry (possible when entering from a denser medium) reflects
the primary ray normally; no particle is created.

### Advance pass

Runs at the top of `trace()`, before the primary ray pass, so this
frame's exits can join the emission list. For each delay element with
a non-empty pool:

1. Compute `step = (1 / delayK) * dt * simRate`.
2. For each particle: step `(lx, ly)` forward by `(ldx, ldy) * step`.
3. Beer-Lambert decay: `I *= exp(-α(λ) * step)`. Cull if `I <
   PARTICLE_EPS`.
4. **Inside test** (`pointInPolygon` on the element's local polygon):
   - Still inside → commit, emit a trail segment
     `(lastLx,lastLy) → (lx,ly)` in world coords (colored
     `(r,g,b) × I`), update `lastLx/Ly`.
   - Stepped outside → find the crossed edge via `segSegT`, clip to
     the crossing, emit trail up to exit, then refract or TIR (see
     below).

Local polygon arrays are reused across frames (written in-place, not
`.map()` allocated).

### Exit refraction

When a particle steps outside its polygon:

1. Find the nearest edge crossing (`segSegT` on the advance step
   against each local polygon edge).
2. Compute the outward local normal from the crossed edge (same CW/CCW
   formula as `worldEdges`). **Negate** it to get the incident-side
   normal (pointing into the glass), matching the primary tracer's
   `snx = -nx` convention for exits.
3. Determine the outside medium at the exit world point by testing
   other dielectric polygons.
4. Snell refraction from `n_glass` to `n_outside`:
   - Refracted → queue a secondary emission (flat `Float32Array`, 10
     floats per entry: `[ox, oy, dx, dy, wl, r, g, b, I, skipElId]`).
     Remove particle from pool.
   - TIR → reflect the local direction, nudge position inward, keep
     the particle alive with `GLASS_LOSS` attenuation.

### Secondary-ray tracing

After the primary pass, secondary emissions are traced via `castRay`
with `skipElId` set to the exiting element (prevents immediate
re-entry on the first edge test; cleared after the first intersection
loop so subsequent bounces can re-enter). Sensor deposits from
secondary rays are routed to the persistent sensor accumulator (see
below) via an `_isSecondary` flag.

### Persistence caches

Secondary-ray outputs (segments and sensor deposits) are single-frame
events — they exist only when a particle exits. Without persistence,
the post-glass ribbon flickers because a different set of particles
exits each frame.

**Exit segment cache** (`_exitSegs`): secondary-ray segments are
cached at `(1 - PERSIST_DECAY)` = 0.20 intensity and NOT emitted
into the main segment buffer directly. The cache is decayed by
`PERSIST_DECAY` = 0.80 each frame, then emitted in full after the
secondary pass. Steady-state brightness:
`0.20 / (1 - 0.80) = 1.0×` — matches primary-ray brightness.

**Persistent sensor accumulator** (`_sensorPersist`): same decay
logic. Secondary castRay deposits write to this array (scaled by
`1 - PERSIST_DECAY`); it's decayed each frame and merged into
`sensorBins` at the end of `trace()`. Primary deposits go directly
to `sensorBins` as before — no change for non-delay scenes.

## Synth integration

Phase 1's per-voice `DelayNode` is gone. Audio delay falls out of
the physics: photons that traversed a delay element reach the sensor
on the frame they exit, so the synth's `sensorBins` (including the
persistent accumulator) naturally reflects the delayed arrival.
Releasing a keyboard note keeps the synth playing as long as
particles are still draining from the glass.

The synth is now a single `AudioWorkletProcessor` receiving
`sensorBins` via `MessagePort` each frame. No `DelayNode`, no
wet/dry split, no `sensorDelay` parameter, no per-voice WebAudio
graph nodes.

## Visual: delay haze

Elements with `delayK > 0` get increased `tintStrength` in the
renderer (`delayK * 80`, capped at 0.5), giving them a foggy/hazy
appearance. Zero-delay elements are unaffected. A per-element
`el.color` override still takes precedence over the haze tint.

## Sim rate

The **Sim rate** slider (`docs/play.html`, Audio in dropdown) is a
log-scaled multiplier (0.05× … 4×, default 1×) on the advance
`dt`. `4×` makes slow-glass drain 4× faster; `0.25×` makes it 4×
more viscous. It does NOT scale mic input sampling or the primary
ray pass — only time inside a delay material.

## RAF idle gate

The frame loop re-traces whenever `dirty` OR
`tracer.activeParticleCount() > 0`. Non-delay scenes never populate
a pool, so they idle on dirty alone — identical to pre-delay
behaviour.

## Zero-delay cost

When no element in the scene has `delayK ≥ DELAY_MIN`:

- `_hasDelay` flag is false; advance pass skips entirely.
- `castRay` checks `elInfo.delayK >= DELAY_MIN` per dielectric hit
  (one boolean, predicted-taken fall-through).
- No pools, no secondary emissions, no persistence caches.
- Segment stride is 12 floats (no chase-era `tStart`/`tEnd`).
- Synth has no `DelayNode`.
- RAF idles on dirty alone.

Cost is identical to pre-delay in every measurable dimension.

## Subtle interactions

- `delayK` change mid-flight applies to the next advance step, not
  retroactively.
- Element rotation / scale during flight transforms held particles
  implicitly (local coords).
- Element deletion drops the pool entirely and flushes persistence
  caches for the element (`_exitSegCount` zeroed, `_sensorPersist`
  filled with 0) to prevent ghost exit segments and sensor deposits.
- `tracer.resetPersistence()` zeros `_exitSegCount`, `_sensorPersist`,
  clears `_pools` and `_localPolys`. Called on clear / file-load /
  preset-load via `onSceneReset`. The tracer also self-resets all
  persistence when it detects a `scene.generation` mismatch at the top
  of `trace()`, as a safety net.
- Near-TIR entry: captured particle has low `I` from `GLASS_LOSS`;
  may die on first absorption step.
- Exit into another delay element: secondary ray's `castRay` captures
  into the new element's pool. Chains correctly.
- Secondary ray re-entering the same element: creates a new particle
  (not the same record). Doubles held count — physically correct for
  concave elements.
- Ribbon density inside glass depends on `raysPerSource` ×
  `delayK` × `simRate`. At defaults (512 rays, 0.002, 1×),
  steady-state is ~6 particles per bench unit along the path.
- Undo restores geometry but does not rewind the photon field.
  In-flight particles continue along their current local paths.
- Persistence cache decay tail (~0.7 s at `PERSIST_DECAY = 0.80`)
  is the "ghosting" you see after input stops — not a bug.

## Choices deferred

- Particle sprite rendering (instanced quads) vs. current trail
  segments.
- Full stateful global simulation (all optics as particles, not just
  delay materials).
- Wavelength-dependent velocity (`v(λ) ∝ 1/n(λ)`).
- Per-element `simRate` override vs. global slider.
- Mic → input delay-tap (echo raw mic, not synth voice).
- Coarse spatial grid inside each element's AABB for O(1)
  `pointInPolygon` in the advance hot loop.
- Per-element max-particle cap for pathological scenes.

## Design history

1. **Phase 1** (shipped, then retired): per-voice `DelayNode` in the
   synth fed by an amplitude-weighted mean `sensorDelay[s]`. Audio
   echo only, no visual.
2. **Phase 2** (shipped, then retired): one-shot draw-in chase
   animation via per-segment `tStart`/`tEnd`, dual clocks
   (`uTphysical`/`uTvisual`), fragment-shader `discard`, onset
   detector, delay-fingerprint re-arm. Stateless — light vanished
   when input stopped; edits drained the ribbon.
3. **Phase 3** (current): stateful particle pools. Light persists
   inside delay glass, drains naturally, carries with the element on
   move/rotate, and produces audio delay from physics alone. Phase 1
   and Phase 2 machinery fully removed.
