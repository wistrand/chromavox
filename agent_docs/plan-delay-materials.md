# Plan: Delay Materials

Status: **Superseded by `plan-stateful-slow-glass.md` (Phase 3).**
Phase 1 (audio-only `DelayNode` echo) and Phase 2 (one-shot visual
chase + dual-clock gating) shipped to main, then were replaced
wholesale in 2026-04-16 by the stateful particle simulation — the
`DelayNode`, chase clock, onset detector, and delay-fingerprint
re-arm machinery are all gone. This file remains for context; for
current behaviour see `plan-stateful-slow-glass.md` and the
architecture docs.

A new optical material kind that adds **temporal delay** to light passing
through it — both as an audio echo on the synth side and as a visible
"crawling light" animation on the rendering side. Same coefficient drives
both, so audio echo timing matches the visual chase by construction.

## Locked-in design

- **Material schema**: `delayK` field on dielectric materials (no new
  type, no UI filter change). Composes with refraction + absorption.
- **Granularity**: scalar amplitude-weighted mean delay per sensor.
  One-tap echo per voice. Multi-tap impulse response is a future
  upgrade.
- **Audio path**: per-voice `DelayNode` (`osc → gainDry → master` plus
  `osc → gainWet → DelayNode → master`). Echoes the resynth voice, not
  the live mic input.
- **Physics source**: delay accumulates only while inside delay
  elements. Inside-stack last-entered-wins covers nesting / overlap.
- **Visual**: Design 2 — animated draw-in. Per-segment `tStart`/`tEnd`,
  global `uT` uniform, fragment shader `discard` when `tAt > uT`. No
  trails (Design 4 deferred). One-shot chase per re-arm, then static.
- **Wavelength dispersion of velocity**: flat for v1. Tying delay to
  `n(λ)` (red/blue separate in time) is a natural extension later.
- **Sensor deposit gating**: gate by **physical clock**, slider only
  affects the visual `uT`. Audio echo timing stays a function of
  `delayK` and geometry; the slider is purely an inspection tool.
- **Re-arm triggers**: `endEdit` (drag/slider release), scene load,
  and major mic-intensity onsets (peak-hold envelope on aggregate
  `tracer.sensorBins` energy with cooldown).
- **Visual rate slider**: global, log scale, default 1×, range
  ~0.05× … 4×. Lives in the Audio-in dropdown alongside an
  **Onset sensitivity** slider.

At slider = 1× the visual chase time and audio echo time match. Below 1×
the chase visibly lags the audio (audio always real-time); above 1× the
chase outruns it.

## Files to touch (estimated surface)

| File | Lines | Adds |
| --- | --- | --- |
| `docs/spectrum.js` | ~5 | `delayK` on materials, `materialDelay(mat)` accessor |
| `docs/raytracer.js` | ~15 | `rayTime` accumulator, 14-float segments, `sensorDelay` + `sensorWeight` arrays, normalize pass |
| `docs/renderer.js` | ~25 | `aTime` instance attribute, `uT` + `uHeadWidth` uniforms, fragment `discard` |
| `docs/synth.js` | ~20 | per-voice `DelayNode` + wet gain, `delayTime` from `tracer.sensorDelay` |
| `docs/main.js` | ~30 | `uTphysical` + `uTvisual` clocks, slider wiring, peak-hold onset detector with cooldown, re-arm hooks |
| `docs/play.html` | 2 sliders | Visual rate, Onset sensitivity |

## Implementation phases

Two phases, each a coherent unit of behavior. Phase 1 ships a real
feature on its own; Phase 2 layers visual onto data Phase 1 already
produces.

### Phase 1 — audio-only delay (DONE)

Goal: dielectric materials with `delayK` produce an audible echo on
the synth side, proportional to internal path length.

Shipped:
- `docs/spectrum.js`: `delayK` field on materials, `materialDelay(mat)`
  accessor. New `slowGlass` material (`delayK = 0.002 s/bench unit`).
- `docs/raytracer.js`: `rayTime` accumulator in `castRay`,
  amplitude-weighted mean delay output as `tracer.sensorDelay` +
  `tracer.sensorWeight` arrays. `MAX_DELAY = 2 s` clamp on `rayTime`.
- `docs/synth.js`: per-voice `voiceMix → dryGain` + parallel
  `wetGain → DelayNode` taps; `update()` drives `delayTime` from
  `tracer.sensorDelay[s]` via `setTargetAtTime`. `MAX_DELAY = 2 s`
  fixed at construction matches the tracer cap.
- `docs/renderer.js`: `LOOK['slowGlass']` (violet tinted refractive)
  + `elementOutlineColor` entry.
- `docs/ui.js`: `MATERIAL_COLOR_HINT['slowGlass']` so the color
  picker defaults sensibly. No filter change — slowGlass is a
  dielectric subtype, picked up automatically.
- `docs/main.js`: passes `tracer.sensorDelay` to `synth.update`.
- Docs: `architecture-materials.md`, `-raytracer.md`, `-audio.md`
  cover the new field, accessor, and audio-graph topology.

### Phase 2 — visual chase (DONE)

Goal: rays visibly crawl across the bench at vacuum speed, slow inside
delay glass, and the audio echo timing matches the visual arrival
(within the slider).

Shipped:
- `docs/raytracer.js`: 14-float segments (`tStart`, `tEnd` appended).
  Dual time accumulators in `castRay` — `rayTimeAudio` (only inside
  delay materials) and `rayTimeVisual` (every segment, at `propK =
  max(delayK, VACUUM_PROP_K)`). Sensor hits no longer write to
  `sensorBins` directly; they append a 5-float row to `sensorEvents`
  (`[sIdx, binIdx, I, rayTimeVisual, rayTimeAudio]`) and update
  `tracer.maxT` and `tracer.totalEnergy`. New
  `tracer.rebuildSensorsGated(uT)` method walks the event log and
  re-populates `sensorBins`/`sensorDelay`/`sensorWeight` skipping
  events with `rayTimeVisual > uT`.
- `docs/renderer.js`: `aTime` instance attribute (vec2), `uT` and
  `uHeadWidth` uniforms. Vertex stride 14×4. Fragment shader:
  `tAt = mix(vTime.x, vTime.y, vAlong); if (tAt > uT) discard;` with
  `1 - smoothstep(uT - uHeadWidth, uT, tAt)` soft leading edge.
- `docs/main.js`: `chaseStart` epoch, `uTphysical` (real time) and a
  phase-accumulated `uTvisual` (`uTvisualAccum += dt * visualRate`) so
  a mid-chase slider change applies going forward instead of rewinding.
  `rebuildSensorsGated(uTphysical)` + `renderer.uT = uTvisual` each
  frame while chase is in flight or dirty; `lastRenderedT` sentinel
  keeps RAF idle once the final frame is on screen. Visual-rate slider
  (log 0.05× … 4×, default 1×) and onset-sensitivity slider (0..1)
  drive `visualRate` and the onset detector. Onset detector compares
  `tracer.totalEnergy` (un-gated) against a peak-hold envelope
  (`onsetEnv`); a sustained note runs flat, a sudden burst above
  `(1 + margin)` re-arms with cooldown `max(0.2s, tracer.maxT * 0.3)`.
- `docs/ui.js`: `History.commit` returns `{changed, delayChanged}`;
  `endEdit` calls `onRearm` only when `delayChanged` (computed via
  `delayFingerprint(scene)` — hashes only delay-material elements'
  id/material/delayK/pose/color). So editing a non-delay element, or
  anything at all in a no-delay scene, no longer drains the current
  ray image. UI constructor takes the `onRearm` callback as the fourth
  arg.
- `docs/play.html` (was `docs/index.html`): visual-rate and
  onset-sensitivity sliders inside the Audio in dropdown.
- Docs: `architecture-overview.md` (render loop + fingerprint),
  `-raytracer.md` (segment layout + gating + visual chase + `emitSeg`
  tracking `maxT`), `-audio.md` (chase gating + slider semantics).

Post-ship tweaks (kept here for the record):
- `VACUUM_PROP_K = 0`. Lightspeed outside delay glass — only segments
  inside a `delayK` material advance the visual clock. Non-delay
  scenes produce `tracer.maxT = 0` and the chase is a no-op.
- `emitSeg` updates `tracer.maxT` from **every** segment end-time
  (not only sensor hits), so rays absorbed at non-sensor walls don't
  get dropped by the renderer's `discard`.
- `main.js` sets `renderer.uT = 1e6` (instead of `uTvisual`) when
  `tracer.maxT == 0`, so the fragment-shader leading-edge fade never
  partially dims rays in non-delay scenes. Pre-Phase-2 behaviour is
  preserved exactly when no delay material is placed.

Ship-ready when: placing a delay element triggers a one-shot wavefront
crawl; the slider visibly slows the chase; bursts of mic input restart
it; audio echo timing is unaffected by the slider; **non-delay scenes
look and behave exactly as before Phase 2**.

Either phase can be paused or shipped independently. Phase 2 depends on
Phase 1's `rayTime` and `sensorDelay` data, but the tracer changes
required by Phase 2 (gating, segment layout) are localized and don't
affect Phase 1's audio output.

## Subtle interactions to keep in mind

- **Audio fires before the visual arrives when slider < 1×.** Deliberate
  separation. Label the slider clearly: "Visual playback rate (audio
  always real-time)".
- **Sensor histogram empty until the wavefront arrives.** Combined with
  the per-voice `DelayNode`, audio onset is doubly delayed (envelope
  build-up + tap delay). If it feels off, mitigate by either
  ungating-the-first-frame, or render audio from the ungated spectrum
  and gate only the visual readouts.
- **Re-arm during slow chase looks abrupt.** Hard-reset `uT = 0`
  suffices for v1. Could be smoothed via crossfade or by lengthening
  the cooldown when slider is slow (`cooldown = max(0.2s,
  currentMaxT_visual * 0.3)`). Mitigated in practice by the
  fingerprint-gated re-arm: unrelated edits no longer re-arm, so the
  only hard resets the user normally sees are ones they deliberately
  triggered (moving slow-glass, a big mic onset, a preset switch).
- **Audio tails not cut on re-arm.** `DelayNode.delayTime.setTargetAtTime`
  lerps smoothly; in-flight audio drains. Cutting would click.
- **Onset detector is mic-side energy only.** Don't read synth-side
  buckets. Bypass entirely when `mic.active` is false.
- **DelayNode count at high sensor counts.** Slider allows up to 1024
  sensors but ~256 active sensors is a realistic ceiling for the
  audio graph (same scaling story as the existing 6-oscillator-per-voice
  synth). Document as a soft limit, not enforced.
- **Tracing is cached across frames; only `uT` advances.** Existing
  dirty-flag system handles this — re-trace on scene change or active
  mic, advance `uT` every RAF until `uT > maxT`. Render runs
  unconditionally while a chase is in flight.
- **`DelayNode.maxDelayTime` is fixed at creation.** Pick a hard cap
  (e.g. 2 s) and clamp both `tracer.sensorDelay[s]` and per-ray
  `rayTime` to it.

## Choices deferred

- **Multi-tap delay histogram per sensor** (richer reverb-like sound)
  vs. the v1 scalar mean.
- **Mic → per-sensor tap → delay → out** (echoes live input) vs. the
  v1 per-voice `DelayNode` (echoes resynth voice).
- **Wavelength-dependent velocity** (`v(λ) ∝ 1/n(λ)` → red/blue
  separate in time inside delay glass).
- **Decay-FBO trails** (Design 4) on top of the draw-in chase.
- **Per-element visual rate slider** vs. global (v1 is global).
- **Onset detector** beyond peak-hold (spectral-flux, L2, etc.).

## UI additions

Two sliders in the Audio in dropdown:

- **Visual rate** (`0.05× … 4×`, log scale, default `1×`).
- **Onset sensitivity** (`0` = never re-arm on audio, `1` = any change
  re-arms).

Optional readout: "Chase: 1.2 s" = static `maxT_physical` once trace
is stable. Live countdown is more useful but visually jittery; static
is the recommended default.

## Why each pick over the alternative

| Pick | Alternative | Why this |
| --- | --- | --- |
| `delayK` on dielectric | `type: 'delay'` | No UI filter change; delay composes with refraction + absorption naturally. |
| Scalar mean delay | Multi-tap histogram | One DelayNode per voice; ships fast. Multi-tap requires bucketing along a time axis and `sensorCount × taps` nodes. |
| Per-voice DelayNode | Mic→tap→delay→out | Drop-in on existing synth graph. Echoing live mic would require routing the mic stream through per-sensor taps — a much bigger redesign. |
| Per-element delay | All optics | Localizes the effect — "place a thing, hear/see an echo" affordance. Every-optic-delays muddies it. |
| Design 2 (draw-in) | Design 1 / 3 / 4 | Literal "slow glass". 1 is undramatic. 3 abandons the ribbon look. 4 is glow not propagation; cheap follow-up. |
| Wavelength-flat velocity | `v(λ) ∝ 1/n(λ)` | Simpler. Spectral chirp inside delay glass is a future upgrade. |
| Physical-clock gating | Slider-stretched gating | Audio echo timing stays physical; slider is pure inspection. |
| Peak-hold onset | Spectral flux / L2 | Reuses existing peak-hold idiom in `synth.js`. Tunable via sensitivity slider. |
| Global visual rate | Per-element | One slider = one mental model. Per-element would multiply UI cost. |
