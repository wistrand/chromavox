# Plan: per-ray carrier (per-emitter / per-note instrument selection)

Each ray carries a `carrierIdx` (which synth carrier it represents:
sine / acid / fm / supersaw / pulse / vocoder / karplus / piano /
noise — see `_CARRIERS` in `synth-worklet.js`). The carrier rides
through every optical interaction unchanged (it's metadata about the
*source*, not a property of the photon). Sensors accumulate per-
`(carrier, wavelength)` energy. The synth plays multiple voices per
sensor, one per active carrier.

This document plans the implementation. Stage order is reversed from
the obvious one — **GPU tracer first** — because the GPU sensor-bin
layout and ray vertex format are the most invasive parts; getting them
right up front avoids a second migration later.

## Conceptual model

A ray is `(position, direction, wavelength, intensity, carrierIdx)`.
Optical interactions:

- Snell refraction → direction changes; carrier unchanged.
- Sellmeier / Cauchy dispersion → wavelength-dependent index splits a
  white ray into a rainbow; each child ray carries the *parent's*
  `carrierIdx`. (We don't actually split rays today — we sample
  wavelengths at emission. Same effect.)
- Beer-Lambert absorption / dichroic / colored glass → attenuate
  intensity per wavelength; carrier unchanged.
- TIR, secondary rays, delay-material capture/re-emit → preserve
  carrier on the captured particle and on every emitted secondary.

**Invariant**: optics never modify `carrierIdx`. If a future material
wants to "filter only piano rays," that breaks the model and turns
the carrier into a participating ray attribute. Don't do it.

## Sensor bin layout (the load-bearing change)

Today: `sensorBins[s * binCount + b]`, `binCount = 64`.

After: `sensorBins[s * (binCount * carrierCount) + c * binCount + b]`,
`carrierCount = 9` (matches `_CARRIERS`). 24 sensors × 9 carriers × 64
bins = 13,824 floats vs. today's 1,536. Memory is fine; the cost is
GPU readback width.

Visualizers (renderer's per-sensor mini-spectrum, edge-memory sensor
side, push display, the spectrum floating window) collapse to the old
behavior by summing across `c` first:

```js
let v = 0;
for (let c = 0; c < carrierCount; c++) {
  v += sensorBins[s * binCount * carrierCount + c * binCount + b];
}
```

That keeps existing visualizations correct without per-call branching.

## Source side (same on CPU and GPU)

`scene.runtime.carrierPerSource: Int8Array(emitter.count)` —
co-managed with `emitter.count` by `ensureRuntimeSize(scene)` exactly
like `wlPerSource`. Default value: `0` (or whichever index maps to
the global synth-carrier dropdown's current selection — TBD; see
"Open questions").

Built per-frame in `main.js`:

1. Start from the per-emitter default in `runtime.carrierPerSource`.
2. Song's `_applyKeyframes` writes per-emitter defaults from
   `song.global.carriers` (a `{emitterIdx: name}` map).
3. Song's `_applyNotes` overrides while a note is active; reverts on
   note-end. Stored similarly to MPE bend's per-emitter `runtime`
   override pattern.
4. Live mic / touch / MIDI: emitter takes the global synth-carrier.

## Stage 0 — schema + plumbing (light, no rendering changes) ✅ SHIPPED

Lands first as a no-op: data structures exist but nothing reads them
yet. Lets us validate sizing / serialization without breaking
anything.

- `scene.js` — extend `ensureRuntimeSize(scene)` to allocate /
  resize `runtime.carrierPerSource` to `emitter.count`. Default-fill
  with carrier-index 0 on grow.
- `song.js` — `_applyKeyframes` reads `g.carriers` (optional
  `{emitterIdx: carrierName}` object); `_applyNotes` writes a
  transient override and reverts at note-end. Uses a small
  `_noteOverrides: Map<emitterIdx, prevCarrierIdx>` so reverts are
  exact. Bumps `scene.generation` only on shape-change, not on
  carrier-change (carrier change doesn't invalidate the tracer's
  per-element pools).
- `agent_docs/design-song-format.md` — document the new
  `global.carriers` and per-note `carrier` fields.
- Scene JSON `version: 1` stays — carrier fields are
  forward-compatible additions; old songs that omit them continue to
  work as before.

**Verification**: load a song that adds `carriers`, log
`runtime.carrierPerSource`, see correct values. No audible / visual
change yet.

Estimate: ~light context, ~5 turns.

## Stage 1 — GPU tracer (the heavy lift, but isolated) ✅ SHIPPED

**Implementation notes**:

- Vertex format unchanged (24 floats / 96 bytes / 6 vec4s). The carrier
  index packs into the high 4 bits of `packedStack` —
  `carrier * 1048576 + stkLen * 262144 + stk[0] * 4096 + stk[1] * 64
  + stk[2]`. Combined max is 16777215 = 2^24 − 1, exactly representable
  in fp32 mantissa. Saved adding a transform-feedback varying.
- Carrier also stamped into `v_segMeta.z` (was unused) so the sensor
  pass reads it directly without unpacking the stack again.
- New textures: `_carrierPerTex` (R32F 64×1) and uniform sampler
  `u_carrierPerSource` + `u_hasCarrierPer`. Bound at TEXTURE4.
  Uploaded each frame from `runtime.carrierPerSource` when present.
- Sensor FBO width grows from `binCount` to `binCount * carrierCount`.
  Sensor shader writes column `carrier * u_binCount + bIdx` for each
  hit. `carrierCount = CARRIER_COUNT (9)` when
  `runtime.carrierPerSource` is set, else 1.
- `tracer.carrierCount` is the public field consumers read; `binCount`
  unchanged.
- Visualizers (`renderer.js` edge-memory + per-sensor mini-spectrum +
  readout, `push.js` display + pad colors, `akai-mpc.js` +
  `akai-apc.js` pad colors) sum across the carrier axis. carrierCount
  === 1 short-circuits to the legacy `s * binCount + b` indexing.
- `synth.js` `update()` collapses the wide bins to per-(sensor,
  wavelength) energy on the way to the worklet for now — Stage 3
  will route per-carrier voices instead.

**Original notes (pre-implementation, kept for reference)**:

Why first: the GPU sensor capture FBO and the ray vertex layout are
the most invasive parts of the whole feature. Doing them now means
the CPU tracer (Stage 2) can target the same `sensorBins` layout
without later disruption, and the synth (Stage 3) sees the final
shape from the start.

### Ray vertex format

Current ray vertex (`gpu-tracer.js`): interleaved `vec4`s for
position+dir, color, etc. Need one extra value per ray.

Pick the cheapest path:

- **Option A — pack into existing slot**: there's likely a
  free-channel byte we can repurpose (e.g. an unused alpha or pad).
  Audit `gpu-tracer.js`'s ray struct and shaders. Cheapest option if
  it works.
- **Option B — new attribute**: add a new attribute to the ray
  buffer (one `float` per ray, used as a small int). Stride increases
  by 4 bytes; transform-feedback varyings list grows by one. All
  shader stages (ray-emit, ray-bounce, sensor-capture) must declare
  + pass-through the new varying.

Go with B if A isn't clean; the overhead is small and it's
self-documenting.

### Sensor capture FBO

Current: capture FBO is `binCount × sensorCount` (R32F float). After:
`(binCount * carrierCount) × sensorCount`. Readback widens from
`24 × 64 = 1,536` floats to `24 × 9 × 64 = 13,824` floats per frame
worst case — 8.6× more `readPixels` data.

Two ways to write it:

- **Wider FBO**: single capture pass, fragment shader writes to
  column `carrierIdx * binCount + bIdx` instead of `bIdx`. Simple.
  One `readPixels`. The whole FBO is always populated, even sparse
  carriers contribute zero columns.
- **Per-carrier passes**: render the same rays C times, each pass
  filtered to one `carrierIdx`. Smaller `readPixels` per pass but C
  draws and C readbacks. Worse on driver overhead; only wins if the
  GPU can early-out efficiently.

Start with wider FBO. If mobile readback shows up as a bottleneck,
revisit.

### `binCount` semantics

`tracer.binCount` is read by every consumer that walks `sensorBins`.
Decision: keep `binCount` as the *wavelength* axis only and add
`tracer.carrierCount` (defaulting to 1 for the legacy CPU path
during transition). All consumers index as
`s * binCount * carrierCount + c * binCount + b`.

When `carrierCount === 1`, the layout collapses to today's exactly.
Visualizers can short-circuit on that case for zero overhead during
transition.

### What's modified

- `gpu-tracer.js` — ray vertex format, all three shader stages,
  sensor capture FBO size, `readPixels` size, `tracer.carrierCount`
  exported.
- `renderer.js` — sensor mini-spectrum, edge-memory sensor side: sum
  across `c` before using the energy. Two functions, mechanical.
- Push display (`midi-devices/push.js`): sums across `c` before
  building palette. Mechanical.
- `main.js` — synth `update(sensorBins, binCount, sensorCount)` call:
  pass `carrierCount` too. Forwarded to worklet via existing
  `port.postMessage` plumbing.

### What stays unchanged

- CPU tracer (`raytracer.js`): writes `sensorBins` with
  `carrierCount = 1` during this stage. Same layout, just the wider
  array. Stage 2 fills in the carrier dimension.
- Synth worklet: still consumes one carrier-collapsed signal during
  this stage. Same audio behavior as today; the per-carrier energy
  exists in `sensorBins` but is just zeroes outside `c = 0`.

**Verification**: GPU-tracer scenes look identical to before. Run
`npm test`. Drop a song with `global.carriers` set and confirm the
ray buffer contains correct `carrierIdx` values via a debug
readback. Spectrum visualizer unchanged.

Estimate: ~heavy context, ~20–25 turns. The vertex-format edits and
shader changes touch every shader stage in the GPU tracer; one full
re-read of `gpu-tracer.js` is mandatory before starting.

## Stage 2 — CPU tracer parity

Mirror the GPU tracer changes in `raytracer.js`:

- Read `runtime.carrierPerSource[s]` at emission, store in the ray
  struct (CPU-side; trivial — one extra property).
- Carry through `castRay`'s recursion and the secondary-ray queue.
- Add to particle struct in delay pools (`docs/js/raytracer.js`,
  search `_pools`). Re-emission preserves it.
- Sensor capture writes to the new layout
  `s * binCount * carrierCount + c * binCount + b`.
- `tracer.carrierCount = scene.runtime.carrierPerSource ? 9 : 1`
  (9 if any carrier is non-zero; 1 if all sources use carrier 0,
  same as the legacy collapsed path).

CPU tracer's correctness is easy to verify: with `carrierPerSource`
all-zero, `sensorBins` should match the pre-change exactly.

Estimate: ~medium context, ~10 turns.

## Stage 3 — synth voice expansion ✅ SHIPPED

**Implementation notes:**

- `synth-worklet.js` now allocates voices as `sensorCount × carrierCount`
  in `_rebuildPartials`. Each voice has a `carrierIdx` field (0..cc−1).
  The flat layout is `voices[s * cc + c]`.
- `_CARRIERS_BY_IDX` is the index-keyed dispatch table (sine=0, noise=1,
  acid=2, fm=3, supersaw=4, pulse=5, vocoder=6, karplus=7, piano=8 —
  matches `Object.keys(CARRIERS)` in `carriers.js`).
- **carrierIdx 0 = "use the global synth-carrier"** per the plan's
  open-question recommendation. Voices in column 0 dispatch via
  `_CARRIERS_BY_IDX[_NAME_TO_IDX[this.carrier]]`. Voices in columns
  1..cc−1 dispatch via `_CARRIERS_BY_IDX[carrierIdx]`. Resolved per-block
  via the local `effectiveIdx(vIdx)` closure.
- Per-voice smoothing: `_SMOOTH_SEC_BY_IDX[effIdx]` — each voice gets the
  smoothing constant of its effective carrier. Previously global; now
  per-block per-voice.
- Per-voice gainK: `_SINGLE_BAND_BY_IDX[effIdx]` — sine voices use K
  partials, single-band carriers use 1. Each voice's `targetGains[]`
  is built from its own carrier slice
  (`bins[s * bc * cc + c * bc + b]`).
- Vocoder pre-pass: now gated on `_anyVocoder` (any voice's effective
  carrier === vocoder) instead of `this.carrier === 'vocoder'`. The
  `vocQ`/`vocAtk`/`vocRel` ctx fields are populated under the same
  gate.
- Pan: now based on **sensor index** (`s / (sc-1)`), not voice index.
  Without this, carrierCount > 1 would interleave pan positions
  (sensor 0's piano hard left, sensor 0's vocoder slightly right of
  it, etc.). Each (s, c) voice at the same sensor s gets the same pan.
- Piano coast-and-strike fix: only applies to voices with
  `carrierIdx === 0` on global-carrier change; voices with fixed
  `carrierIdx > 0` keep their state.
- Active-voice gate (`anyActive` check + 3-block coast) is unchanged.
  Voices with no energy across all gain partials are skipped at near-
  zero CPU. With per-(s,c) voices, only those carrying real energy
  pay the dispatch cost — the threshold-gating keeps total active
  voices bounded.
- `synth.js`'s `update()` now forwards `sensorBins` directly without
  collapsing. `rebuild()` accepts an optional `carrierCount`
  parameter, sent to the worklet's rebuild message; voice array is
  re-allocated to match. `update()` triggers a rebuild if
  `carrierCount` changed since the last call, keeping the worklet's
  voice topology in sync with whatever `tracer.carrierCount` reports.
- Worklet's bin-length check is now
  `bins.length >= sensorCount * binCount * carrierCount` instead of
  `>= sensorCount * binCount`.

The synth worklet now sees per-`(sensor, carrier)` energy. Voices
need to multiply.

### Per-voice carrier dispatch

Current: one carrier function chosen globally, all voices share it.

After: each voice has a `carrierIdx`; the inner loop dispatches via
`_CARRIERS[v.carrierIdx]`. Per-voice carrier params live in the same
`ctx.P` object today; either (a) split into per-carrier param sets
(`ctx.P[carrierIdx]`) or (b) keep params global and only the carrier
function differs. Option (b) is simpler — for now, all carriers
share params; the song-format work can later add per-carrier params.

### Voice allocation

Naïve: `sensorCount × carrierCount` voices = ~216 worst case for 24
sensors × 9 carriers. Heavy.

Active-only allocation: at the start of each `process()` block, scan
the bins; for each `(s, c)` with energy above a threshold, allocate /
reuse a voice. Free voices at energy-zero with a release tail.
Realistic peak: ~30–80 active voices. Comparable to a busy chord
on a polyphonic synth.

Voice cap: a hard ceiling (e.g. 96) prevents pathological scenes
from blowing the audio budget. When hit, drop the lowest-energy
voices.

### Frequency assignment

Today: each sensor `s` has a fixed frequency from
`scaleFreq(baseHz, mode, s, stepSemi)`. After: each `(s, c)` voice
plays the same per-sensor frequency, different carrier. So frequency
is per-sensor; carrier is per-voice.

### Wavelength-bin → carrier mix

Within a sensor, the carrier energies are summed bins:

```
voiceEnergy[s][c] = sum over b of sensorBins[s,c,b]
```

That's the gain on the (s, c) voice. The wavelength distribution
within each `c` slice doesn't change synthesis (today's vocoder
already collapses bins to a single gain too).

### What's modified

- `synth-worklet.js` — voice struct gets `carrierIdx`; dispatch loop
  uses `_CARRIERS[v.carrierIdx]`; voice allocator scans per-`(s,c)`.
- `synth.js` — `update()` accepts the wider `sensorBins` and forwards
  with `binCount + carrierCount`.
- New telemetry in stats panel: voice-count breakdown by carrier.

Estimate: ~medium context, ~12–15 turns. The voice-allocator changes
are the trickiest; everything else is mechanical.

## Stage 4 — UI surfacing (optional polish) ⏳ PARTIAL

**Shipped:**
- **MIDI import** (`midi.js`) now produces multi-instrument songs:
  GM program → Chromavox carrier mapping (`programToCarrier`,
  `trackCarrier`); each note carries its track's carrier, and the
  global synth-carrier is the user's dropdown selection. Track-name
  detection (piano/strings/etc.) overrides program when present. The
  MIDI track picker UI shows the inferred carrier next to each track
  name (`"Strings — Strings → supersaw (ch3)"`). Welcome banner now
  lists the unique carriers when more than one is in play.
- **Per-emitter indicators** (`main.js` + `style.css`): each emitter
  label gains a small `.ec` sub-span. When a song sets a non-zero
  carrier for an emitter (via `global.carriers` or per-note
  `carrier`), a 2-letter code shows next to the frequency label
  (`n`, `a`, `fm`, `ss`, `pu`, `vc`, `kp`, `pn`). Default carrier
  (sine / "use global") shows nothing. Updated each frame from
  `runtime.carrierPerSource`; DOM writes are skipped when the value
  hasn't changed. Faded blue accent so it doesn't compete with the
  frequency label.

**Still optional:**

Once functional, expose the feature to users:

- **Per-emitter carrier indicator** in the bench overlay (small
  icon/letter near each emitter's tick when its carrier ≠ default).
- **Carrier picker** alongside the synth-carrier dropdown so users
  can override per-emitter without editing JSON.
- **Push integration**: encoder per emitter selects carrier; pad
  color hint by carrier identity.
- Spectrum window: stacked carrier slices instead of summed
  bins (debug view).

Estimate: ~light, ~8–12 turns. Not load-bearing for the feature.

## Open questions (decide before Stage 1)

1. **Carrier-index 0 default — does it mean "use the global synth
   carrier" or "always carrier 0 (sine)"?** Recommend: 0 means
   "the global synth-carrier dropdown's current value." Songs that
   set `carriers` override. Live input always uses the global.
   Keeps backwards compatibility automatic.
2. **`carrierCount` constant or scene-dependent?** Recommend:
   constant = 9 (matches `_CARRIERS`), even if a scene only uses 2
   carriers. Simpler indexing; sparse carriers cost zero
   `readPixels` time (the columns are just zero). Variable
   carrierCount means re-allocating the FBO on song change, which
   is more headache than the savings warrant.
3. **Per-carrier params (acidRes, fmDepth, etc.) — global or
   per-carrier in the song?** Recommend: defer to after Stage 3
   ships. Initially all carriers share the global `ctx.P` set by
   the synth UI. Adding per-emitter or per-note carrier params is
   a clean extension once the rest works.
4. **Mic / non-deterministic sources**: do we ever route a mic
   source through a per-emitter carrier? Recommend: the global
   synth-carrier picks the carrier for mic-driven emitters
   (carrierIdx is set from the global selection per frame). Songs
   override via `carriers`. Mixed scenes (mic + song) just compose.

## Risks

- **GPU readback widening (8.6×)**. The single biggest perf risk.
  Mitigations: split into per-carrier passes only if needed (hold
  off until measured); allow `carrierCount = 1` fast path that's
  identical to today (so users without per-carrier songs get zero
  perf hit).
- **Voice count blowup**. Mitigated by active-only allocation +
  hard voice cap. Stats panel exposes `numVoices` so we'll see it
  immediately when load grows.
- **Vertex-format edit cascade in GPU tracer**. Touching the ray
  struct hits ray-emit / ray-bounce / sensor-capture shaders all
  at once. Two failure modes: silent wrong values (read uninit
  attribute) and varying-list mismatches (transform feedback won't
  link). Mitigation: write a small standalone test scene with a
  known carrier per emitter and a debug readback that asserts the
  carrier values arrived at the right sensors.
- **Visualizer regression**. Edge memory + mini-spectrum + push
  display all read `sensorBins`; if any forgets to sum across
  `c` it'll show wrong colors. Single grep for `sensorBins[`
  catches them all.

## Demo arguments

- A piano-emitter and a vocoder-emitter on the same bench. A prism
  splits piano rays into a rainbow; a mirror routes vocoder rays
  to specific sensors. Each sensor receives a custom mix of
  piano-spectrum + vocoder-spectrum, optically determined by
  geometry.
- A multi-track MIDI piece plays as melody-on-piano +
  bass-on-acid + pads-on-vocoder simultaneously, with optics
  determining which sensor "hears" what.
- Existing MIDI track picker (`_midiCarrier`, GM program → carrier
  hint) extends naturally: each track tags its notes with its
  picked carrier, the song JSON includes `carrier` per note, the
  rest of the pipeline lights up.

## Cross-references

- `agent_docs/architecture-raytracer.md` — CPU tracer ray + sensor
  capture pipeline.
- `agent_docs/architecture-gpu-tracer.md` — GPU tracer transform
  feedback layout (read this whole file before Stage 1).
- `agent_docs/architecture-audio.md` — synth voice / carrier
  dispatch architecture.
- `agent_docs/design-song-format.md` — extends here in Stage 0
  with `carriers` and per-note `carrier` fields.
- `agent_docs/architecture-overview.md` — Stage-1 changes touch
  the renderer's edge-memory + sensor mini-spectrum description
  near the end of the renderer module section.
