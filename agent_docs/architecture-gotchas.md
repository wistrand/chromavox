# Architecture: Known Gotchas

## Rendering

- `gl.lineWidth` is driver-clamped to 1 px on nearly all WebGL
  implementations. Rays avoid this by rendering as instanced SDF
  quads (`docs/renderer.js`). Overlay elements (bench outline,
  emitter/sensor ticks, element polygons, per-sensor mini-spectrum)
  still use line primitives; emitter ticks stack a few parallel 1 px
  lines vertically to look thicker.
- Additive blending is the right model for accumulated light. With
  the HDR ray FBO (`RGBA16F` + Reinhard tone-mapping) channels can
  freely sum past 1.0 and get compressed softly on display, so dense
  overlap stays colorful rather than clamping to white. The fallback
  path (when `EXT_color_buffer_float` isn't available) clamps at 1.0
  before the tonemap and exhibits the old neon-white-on-overlap
  behaviour.
- Element interiors are drawn as bounding-box quads; the fragment
  shader runs a polygon-SDF loop up to `MAX_EDGES` (defined in
  `docs/renderer.js`) to clip and sample the underlying ray FBO with
  a distortion offset. Polygons with more edges than that will be
  silently clipped — bump `MAX_EDGES` (and verify the uniform array
  fits within the GPU's component limit) if you add a new element
  shape that needs more vertices than the current circle (128).

## Physics

- `hyper` and `diamond` materials illustrate the `n < 2` TIR
  constraint on a 60° prism — don't mistake internal bouncing for a
  physics bug. See `architecture-raytracer.md`.
- Block zigzag is also real physics: adjacent faces of a rectangular
  dielectric always TIR, so rays can only exit through the parallel
  opposite face.
- Overlapping dielectrics work (inside-element stack resolves `n1` /
  `n2` and Beer-Lambert α correctly), but the stack uses
  *last-entered* as the current medium. For deliberately ambiguous
  overlaps, the picked medium depends on which element the ray
  entered first.

## Phase 3 particle simulation

- A delay element's pool is keyed by `el.id`. Deleting the element
  drops the pool entirely — in-flight photons vanish — and flushes
  persistence caches (`_exitSegCount` zeroed, `_sensorPersist` filled
  with 0) so ghost segments and sensor deposits don't linger.
- Particles are stored in element-local coordinates. Moving /
  rotating / scaling the element carries held light with it by
  construction. World-space transforms happen only at trail-emission
  and exit refraction.
- Single-attachment rule: a particle belongs to the element it
  entered. Overlapping another delay element mid-flight does NOT
  re-attach. Chained delay materials work *after* the first particle
  exits and its secondary ray re-captures into the new element.
- Exit edge detection uses `segSegT` on the advance step against
  every local polygon edge. If the step somehow overshoots without a
  detected crossing (numerical edge case, e.g. a tangent grazing),
  the particle is dropped. At typical speeds this never triggers.
- The main-loop idle gate is `tracer.activeParticleCount() > 0 ||
  dirty`. If you add other stateful subsystems that need per-frame
  stepping, fold them into the same gate or RAF will idle.
- `simRate` scales the advance `dt` but does **not** scale mic input
  sampling or the primary ray pass. It only affects time *inside* a
  delay material.
- `DELAY_MIN` threshold (0.0003): elements with `delayK` below this
  are treated as normal dielectrics — no particle capture. This
  prevents near-zero delay values from triggering the particle path
  unnecessarily.
- Exit segment persistence cache and persistent sensor accumulator
  (`PERSIST_DECAY = 0.80`) smooth secondary-ray output. If you see
  "ghosting" of exit segments or sensor energy after input stops, this
  is the decay tail, not a bug.

## Audio

- `synth.setBase()` rebuilds voices for all modes. Previously it
  only rebuilt for chromatic, so changing Base in major/minor/etc
  had no effect until a mode switch forced a rebuild.
- Chromatic mode range equals `count × stepSemi` semitones — bump
  count or widen Span to see more of the input spectrum.
- `AudioContext.setSinkId()` is not supported in older browsers; the
  app silently falls back to the system-default audio output.
- Mic stream requests disable AGC / AEC / NS in the constraints. On
  Linux/PipeWire some drivers still apply processing out of our
  control; verify with OS tools like `pavucontrol`.
- `navigator.mediaDevices` is only defined in a **secure context** —
  HTTPS or `localhost`. Plain HTTP on a LAN hostname leaves it
  `undefined`, so `mic.enable('mic')` throws a clear guard error
  instead of crashing. Workarounds: serve over HTTPS (e.g. `ngrok`,
  `cloudflared`), flip the browser's "treat insecure origin as
  secure" override flag (Chrome:
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`; Firefox:
  `about:config` `media.devices.insecure.enabled` and
  `media.getusermedia.insecure.enabled`), or pick a synthetic source
  (sine / harmonics / noise / keyboard) which doesn't need
  `mediaDevices`.

## UI / state

- Slider sanity: nothing prevents `wlMin > wlMax`; the tracer handles
  it but the output gets weird.
- Large ray counts are capped by the slider max in
  `docs/play.html`. The per-segment buffer can balloon at high
  counts; watch for perf drops on low-end mobile.
- The element material dropdown filters by element kind
  (`dielectric` / `mirror`); switching a mirror to a dielectric is
  not exposed in the UI — change via JSON edit if needed.
- Bench is letterboxed at the canonical portrait golden-ratio aspect.
  `renderer.resize()` computes the viewport size in JS — don't revert
  this to pure CSS `aspect-ratio` + `max-width`; the CSS approach
  breaks on narrow mobile portrait screens (height: 100% wins over
  the aspect ratio when max-width clamps). Resizing the window does
  not move any element; the stage just shows more or less black bar.
  Preset loads with mismatched bench dimensions get rescaled to
  canonical inside `deserializeScene`.
- Toolbar has a fixed height with `box-sizing: border-box`,
  `overflow-x: auto`, and `overflow-y: hidden`; on narrow viewports
  the horizontal scrollbar appears inside the bar rather than
  compressing it.
- Scene auto-saves to `localStorage` on every `markDirty`. If
  localStorage is unavailable (private browsing, quota exceeded) the
  save silently fails; the app still works.
- `tracer.resetPersistence()` must be called on scene transitions
  (clear, load, preset) to avoid stale exit-segment and sensor
  persistence data bleeding into the new scene. The `onSceneReset`
  callback handles this. Additionally, `scene.generation` (incremented
  by `createScene()`) triggers the tracer to self-reset all persistence
  at the top of `trace()` on generation mismatch, as a safety net
  against missed manual resets.
- Changing the emitter count clears `emitter.disabled` so stale
  toggle indices from a previous count don't persist. On clear/load,
  the fresh `createScene()` provides a clean `emitter.disabled`
  automatically.
- Deleting a delay element drops its pool and flushes the persistence
  caches (`_exitSegCount` zeroed, `_sensorPersist` filled with 0) so
  ghost exit segments and sensor deposits don't linger.
- Elements with `el.spin` keep the render loop active even when
  nothing else is dirty. If spin is set to zero the element stops
  marking dirty.
